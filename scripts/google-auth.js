#!/usr/bin/env node
// One-time OAuth to get a Gmail refresh token for drafts. Writes GOOGLE_REFRESH_TOKEN into .env.
// Needs a Google Cloud OAuth client of type "Desktop app"; put its id and secret in .env first.
const fs = require('fs');
const path = require('path');
const http = require('http');

const ENV = path.join(__dirname, '..', '.env');
try { process.loadEnvFile(ENV); } catch {}

const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const PORT = 4142;
const REDIRECT = `http://localhost:${PORT}/callback`;
// compose: create drafts. readonly: read thread headers so drafts land as replies in the thread.
const SCOPES = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.readonly'];

const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: id, redirect_uri: REDIRECT, response_type: 'code',
  scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
})}`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/callback') return res.end();
  const code = u.searchParams.get('code');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  });
  const data = await r.json();
  if (!data.refresh_token) {
    res.end('No refresh token returned. Check the terminal.');
    console.error(data);
    process.exit(1);
  }
  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  env = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env)
    ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${data.refresh_token}`)
    : `${env.replace(/\n?$/, '\n')}GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`;
  fs.writeFileSync(ENV, env);
  res.end('Done. You can close this tab.');
  console.log('Saved GOOGLE_REFRESH_TOKEN to .env');
  server.close();
});

server.listen(PORT, () => console.log(`Open this URL and approve:\n\n${url}\n`));
