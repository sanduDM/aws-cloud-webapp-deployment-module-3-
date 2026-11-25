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

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: await getDbPassword(),
    ssl: { rejectUnauthorized: false }, // RDS requires SSL; fine for coursework
  });

  const app = express();

  // Log every request
  app.use((req, res, next) => {
    log('info', 'request', { method: req.method, url: req.url });
    next();
  });

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

  const port = process.env.PORT || 3000;
  app.listen(port, () => log('info', 'server started', { port }));
}

main().catch((err) => {
  log('error', 'startup failed', { error: err.message });
  process.exit(1);
});
