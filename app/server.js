require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const SUBJECTS = ['General', 'Cloud', 'Linux', 'Networking', 'Databases', 'Security', 'DevOps'];

// One JSON log line per event, written to stdout (PM2 stores it)
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));
}

// DB password comes from Parameter Store through the EC2 IAM role (no keys in code)
async function getDbPassword() {
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD; // local fallback only
  const ssm = new SSMClient({ region: process.env.AWS_REGION });
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env.DB_PASSWORD_PARAM, WithDecryption: true })
  );
  return res.Parameter.Value;
}

// ---------- Shared page layout ----------
const CSS = `
:root{--bg:#f4f6fb;--card:#fff;--text:#1d2433;--muted:#6b7385;--line:#e3e7f0;--accent:#2f6df6;--danger:#d64545}
@media (prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#171e2e;--text:#e8ecf5;--muted:#93a0b8;--line:#263049;--accent:#6c9bff;--danger:#ff7b7b}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}
header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:860px;margin:auto;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{font-weight:700;font-size:20px}nav a{margin-left:16px;color:var(--muted);text-decoration:none;font-weight:600}nav a.on{color:var(--accent)}
main{max-width:860px;margin:24px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center}
.stat b{display:block;font-size:26px;color:var(--accent)}.stat span{font-size:13px;color:var(--muted)}
form{display:flex;gap:8px;flex-wrap:wrap}
input,select,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
input{flex:1;min-width:160px}button{cursor:pointer}
.primary{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.chip{padding:5px 12px;border-radius:999px;font-size:13px}.chip.on{background:var(--accent);color:#fff;border-color:var(--accent)}
ul{list-style:none;margin:0;padding:0}
.note{display:flex;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}
.note:last-child{border-bottom:0}.note.pinned .text:before{content:"\\1F4CC  "}
.text{font-size:16px;word-break:break-word}.meta{font-size:12px;color:var(--muted);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
.badge{background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:1px 9px}
.acts{display:flex;gap:6px;align-items:flex-start}.ghost{padding:5px 10px;font-size:13px}.danger{color:var(--danger)}
#empty{color:var(--muted);text-align:center;padding:24px 0;display:none}
footer{max-width:860px;margin:0 auto 32px;padding:0 16px;color:var(--muted);font-size:13px;display:flex;gap:8px;align-items:center}
.dot{width:9px;height:9px;border-radius:50%;background:#aaa;display:inline-block}.dot.ok{background:#27ae60}.dot.bad{background:var(--danger)}
h2{margin-top:0}td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}table{border-collapse:collapse;width:100%}
@media(max-width:560px){.note{flex-direction:column}.stats{grid-template-columns:1fr 1fr 1fr}}
`;

function layout(title, active, body, script) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${CSS}</style></head><body>
<header><div class="bar"><div class="brand">&#9729; Cloud Study Hub</div>
<nav><a href="/" class="${active === 'notes' ? 'on' : ''}">Notes</a><a href="/about" class="${active === 'about' ? 'on' : ''}">About</a></nav></div></header>
<main>${body}</main>
<footer><span class="dot" id="dot"></span><span id="status">Checking server...</span></footer>
<script>
fetch('/health').then(function(r){return r.json()}).then(function(h){
  document.getElementById('dot').className='dot ok';
  document.getElementById('status').textContent='Online. Database connected. Server time '+new Date(h.dbTime).toLocaleTimeString();
}).catch(function(){document.getElementById('dot').className='dot bad';document.getElementById('status').textContent='Server problem';});
${script}
</script></body></html>`;
}

const HOME_BODY = `
<div class="stats">
  <div class="stat"><b id="s-total">0</b><span>Notes</span></div>
  <div class="stat"><b id="s-pinned">0</b><span>Pinned</span></div>
  <div class="stat"><b id="s-subjects">0</b><span>Subjects used</span></div>
</div>
<div class="card">
  <form id="form">
    <input id="text" maxlength="200" placeholder="Write a study note..." autocomplete="off">
    <select id="subject"></select>
    <button class="primary" type="submit">Add note</button>
  </form>
</div>
<div class="card">
  <input id="search" placeholder="Search notes..." style="width:100%">
  <div class="chips" id="filters"></div>
  <ul id="list"></ul>
  <div id="empty">No notes found.</div>
</div>`;

const HOME_SCRIPT = 'var SUBJECTS = ' + JSON.stringify(SUBJECTS) + ';\n' + `
var state = { subject: '', q: '' };
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
async function api(method, url, body) {
  var r = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function loadStats() {
  var s = await api('GET', '/api/stats');
  document.getElementById('s-total').textContent = s.total;
  document.getElementById('s-pinned').textContent = s.pinned;
  document.getElementById('s-subjects').textContent = s.subjects;
}
function buildFilters() {
  var box = document.getElementById('filters'); box.innerHTML = '';
  ['All'].concat(SUBJECTS).forEach(function (s) {
    var on = (s === 'All' && !state.subject) || s === state.subject;
    var b = el('button', 'chip' + (on ? ' on' : ''), s);
    b.onclick = function () { state.subject = s === 'All' ? '' : s; buildFilters(); loadNotes(); };
    box.appendChild(b);
  });
}
async function loadNotes() {
  var notes = await api('GET', '/api/notes?q=' + encodeURIComponent(state.q) + '&subject=' + encodeURIComponent(state.subject));
  var ul = document.getElementById('list'); ul.innerHTML = '';
  document.getElementById('empty').style.display = notes.length ? 'none' : 'block';
  notes.forEach(function (n) {
    var li = el('li', 'note' + (n.pinned ? ' pinned' : ''));
    var main = el('div', 'main');
    main.appendChild(el('div', 'text', n.text));
    var meta = el('div', 'meta');
    meta.appendChild(el('span', 'badge', n.subject));
    meta.appendChild(el('span', '', new Date(n.created_at).toLocaleString()));
    main.appendChild(meta);
    var acts = el('div', 'acts');
    var pin = el('button', 'ghost', n.pinned ? 'Unpin' : 'Pin');
    pin.onclick = async function () { await api('PUT', '/api/notes/' + n.id, { pinned: !n.pinned }); refresh(); };
    var edit = el('button', 'ghost', 'Edit');
    edit.onclick = async function () { var t = prompt('Edit note', n.text); if (t && t.trim()) { await api('PUT', '/api/notes/' + n.id, { text: t }); refresh(); } };
    var del = el('button', 'ghost danger', 'Delete');
    del.onclick = async function () { if (confirm('Delete this note?')) { await api('DELETE', '/api/notes/' + n.id); refresh(); } };
    acts.append(pin, edit, del);
    li.append(main, acts); ul.appendChild(li);
  });
}
function refresh() { loadStats(); loadNotes(); }
var sel = document.getElementById('subject');
SUBJECTS.forEach(function (s) { var o = el('option', '', s); o.value = s; sel.appendChild(o); });
document.getElementById('form').onsubmit = async function (e) {
  e.preventDefault();
  var input = document.getElementById('text'); var t = input.value.trim(); if (!t) return;
  await api('POST', '/api/notes', { text: t, subject: sel.value });
  input.value = ''; refresh();
};
var timer;
document.getElementById('search').oninput = function (e) {
  clearTimeout(timer); var v = e.target.value;
  timer = setTimeout(function () { state.q = v; loadNotes(); }, 250);
};
buildFilters(); refresh();
`;

const ABOUT_BODY = `
<div class="card"><h2>About this project</h2>
<p>Cloud Study Hub is a small web app I deployed on AWS for Module 03 (Cloud Services &amp; Web App Deployment). It is used to keep study notes by subject.</p></div>
<div class="card"><h2>How it runs</h2>
<table>
<tr><th>Layer</th><th>What I used</th></tr>
<tr><td>Web server</td><td>Nginx reverse proxy on EC2 (port 80)</td></tr>
<tr><td>Application</td><td>Node.js and Express, kept running by PM2</td></tr>
<tr><td>Database</td><td>Amazon RDS for PostgreSQL (private)</td></tr>
<tr><td>Secrets</td><td>Password in Parameter Store, read through an IAM role</td></tr>
<tr><td>Network</td><td>Security groups: SSH from my IP only, DB open only to the web server</td></tr>
<tr><td>Monitoring</td><td>CloudWatch CPU alarm with email, JSON app logs</td></tr>
</table></div>`;

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: await getDbPassword(),
    ssl: { rejectUnauthorized: false }, // RDS needs SSL; fine for coursework
  });

  // Create the table, and add the new columns to the old table without losing notes
  await pool.query(
    'CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())'
  );
  await pool.query("ALTER TABLE notes ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'General'");
  await pool.query('ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE');
  log('info', 'database ready');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    log('info', 'request', { method: req.method, url: req.url });
    next();
  });

  app.get('/', (req, res) => res.type('html').send(layout('Cloud Study Hub', 'notes', HOME_BODY, HOME_SCRIPT)));
  app.get('/about', (req, res) => res.type('html').send(layout('About - Cloud Study Hub', 'about', ABOUT_BODY, '')));

  app.get('/health', async (req, res) => {
    try {
      const r = await pool.query('SELECT NOW() AS now');
      res.json({ status: 'ok', dbTime: r.rows[0].now });
    } catch (err) {
      log('error', 'database check failed', { error: err.message });
      res.status(500).json({ status: 'error' });
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE pinned)::int AS pinned, COUNT(DISTINCT subject)::int AS subjects FROM notes'
      );
      res.json(r.rows[0]);
    } catch (err) {
      log('error', 'stats failed', { error: err.message });
      res.status(500).json({ error: 'failed to load stats' });
    }
  });

  app.get('/api/notes', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const subject = String(req.query.subject || '');
    try {
      const r = await pool.query(
        "SELECT id, text, subject, pinned, created_at FROM notes WHERE ($1::text = '' OR text ILIKE '%' || $1::text || '%') AND ($2::text = '' OR subject = $2::text) ORDER BY pinned DESC, id DESC",
        [q, subject]
      );
      res.json(r.rows);
    } catch (err) {
      log('error', 'list notes failed', { error: err.message });
      res.status(500).json({ error: 'failed to load notes' });
    }
  });

  app.post('/api/notes', async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 200);
    const subject = SUBJECTS.includes(req.body && req.body.subject) ? req.body.subject : 'General';
    if (!text) return res.status(400).json({ error: 'text is required' });
    try {
      const r = await pool.query(
        'INSERT INTO notes (text, subject) VALUES ($1, $2) RETURNING id, text, subject, pinned',
        [text, subject]
      );
      log('info', 'note added', { id: r.rows[0].id, subject });
      res.status(201).json(r.rows[0]);
    } catch (err) {
      log('error', 'add note failed', { error: err.message });
      res.status(500).json({ error: 'failed to add note' });
    }
  });

  app.put('/api/notes/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'bad id' });
    const body = req.body || {};
    const text = body.text === undefined ? null : String(body.text).trim().slice(0, 200);
    if (text === '') return res.status(400).json({ error: 'text cannot be empty' });
    const subject = SUBJECTS.includes(body.subject) ? body.subject : null;
    const pinned = typeof body.pinned === 'boolean' ? body.pinned : null;
    try {
      const r = await pool.query(
        'UPDATE notes SET text = COALESCE($1, text), subject = COALESCE($2, subject), pinned = COALESCE($3, pinned) WHERE id = $4 RETURNING id, text, subject, pinned',
        [text, subject, pinned, id]
      );
      log('info', 'note updated', { id });
      res.json(r.rows[0] || {});
    } catch (err) {
      log('error', 'update note failed', { error: err.message });
      res.status(500).json({ error: 'failed to update note' });
    }
  });

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