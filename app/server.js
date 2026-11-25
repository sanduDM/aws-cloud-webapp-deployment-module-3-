require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// Simple JSON logger: one line per event, written to stdout (PM2 / CloudWatch can collect it)
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));
}

// Get the DB password from AWS Systems Manager Parameter Store.
// The EC2 IAM role provides the permission, so no AWS keys are needed in code.
async function getDbPassword() {
  if (process.env.DB_PASSWORD) {
    return process.env.DB_PASSWORD; // optional local fallback, never use on the server
  }
  const ssm = new SSMClient({ region: process.env.AWS_REGION });
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env.DB_PASSWORD_PARAM, WithDecryption: true })
  );
  return res.Parameter.Value;
}

// The web page (served at "/"). Notes are added and deleted through the API below.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloud Notes</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { margin-bottom: 4px; }
  .sub { color: #666; margin-top: 0; }
  form { display: flex; gap: 8px; margin: 20px 0; }
  input { flex: 1; padding: 10px; font-size: 16px; }
  button { padding: 10px 14px; font-size: 14px; cursor: pointer; }
  ul { list-style: none; padding: 0; }
  li { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #ddd; }
  footer { margin-top: 32px; font-size: 13px; color: #888; }
</style>
</head>
<body>
  <h1>Cloud Notes</h1>
  <p class="sub">A small web app deployed on AWS</p>
  <form id="form">
    <input id="text" maxlength="200" placeholder="Write a note..." autocomplete="off">
    <button type="submit">Add</button>
  </form>
  <ul id="list"></ul>
  <footer>Nginx &rarr; Node.js on EC2 &rarr; PostgreSQL on RDS</footer>
<script>
async function load() {
  const r = await fetch('/api/notes');
  const notes = await r.json();
  const ul = document.getElementById('list');
  ul.innerHTML = '';
  notes.forEach(function (n) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = n.text;
    const b = document.createElement('button');
    b.textContent = 'Delete';
    b.onclick = async function () {
      await fetch('/api/notes/' + n.id, { method: 'DELETE' });
      load();
    };
    li.append(span, b);
    ul.append(li);
  });
}
document.getElementById('form').onsubmit = async function (e) {
  e.preventDefault();
  const input = document.getElementById('text');
  const text = input.value.trim();
  if (!text) return;
  await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text })
  });
  input.value = '';
  load();
};
load();
</script>
</body>
</html>`;

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: await getDbPassword(),
    ssl: { rejectUnauthorized: false }, // RDS requires SSL; fine for coursework
  });

  // Create the table on first start
  await pool.query(
    'CREATE TABLE IF NOT EXISTS notes (' +
      'id SERIAL PRIMARY KEY, ' +
      'text TEXT NOT NULL, ' +
      'created_at TIMESTAMPTZ DEFAULT NOW())'
  );
  log('info', 'database ready');

  const app = express();
  app.use(express.json());

  // Log every request
  app.use((req, res, next) => {
    log('info', 'request', { method: req.method, url: req.url });
    next();
  });

  // Home page
  app.get('/', (req, res) => res.type('html').send(PAGE));

  // Health check: proves app -> database works
  app.get('/health', async (req, res) => {
    try {
      const result = await pool.query('SELECT NOW() AS now');
      res.json({ status: 'ok', dbTime: result.rows[0].now });
    } catch (err) {
      log('error', 'database check failed', { error: err.message });
      res.status(500).json({ status: 'error' });
    }
  });

  // List notes
  app.get('/api/notes', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, text FROM notes ORDER BY id DESC');
      res.json(result.rows);
    } catch (err) {
      log('error', 'list notes failed', { error: err.message });
      res.status(500).json({ error: 'failed to load notes' });
    }
  });

  // Add a note
  app.post('/api/notes', async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 200);
    if (!text) return res.status(400).json({ error: 'text is required' });
    try {
      const result = await pool.query(
        'INSERT INTO notes (text) VALUES ($1) RETURNING id, text',
        [text]
      );
      log('info', 'note added', { id: result.rows[0].id });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      log('error', 'add note failed', { error: err.message });
      res.status(500).json({ error: 'failed to add note' });
    }
  });

  // Delete a note
  app.delete('/api/notes/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'bad id' });
    try {
      await pool.query('DELETE FROM notes WHERE id = $1', [id]);
      log('info', 'note deleted', { id });
      res.json({ deleted: id });
    } catch (err) {
      log('error', 'delete note failed', { error: err.message });
      res.status(500).json({ error: 'failed to delete note' });
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => log('info', 'server started', { port }));
}

main().catch((err) => {
  log('error', 'startup failed', { error: err.message });
  process.exit(1);
});