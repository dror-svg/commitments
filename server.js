#!/usr/bin/env node
// Dashboard server. Local only: binds to 127.0.0.1, no auth.
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const express = require('express');
const store = require('./db');
const { composeBrief } = require('./brief');
const inbox = require('./inbox');
const claude = require('./claude');
const gmail = require('./gmail');
const { sync } = require('./sync');

const PORT = Number(process.env.PORT) || 4141;
const SYNC_ON = process.env.SYNC !== 'off';
const PUSH_DELAY_MS = 30_000;
const PULL_EVERY_MS = 5 * 60_000;

// ---- sync scheduling ----
let syncState = { ok: true, action: SYNC_ON ? 'not yet' : 'off', message: '', at: null };
let pushTimer = null;
let lastPull = 0;

function runSync() {
  if (!SYNC_ON) return syncState;
  clearTimeout(pushTimer);
  pushTimer = null;
  syncState = { ...sync(), at: new Date().toISOString() };
  lastPull = Date.now();
  if (!syncState.ok) console.warn(`sync ${syncState.action}: ${syncState.message}`);
  return syncState;
}

function scheduleSync() {
  if (!SYNC_ON) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(runSync, PUSH_DELAY_MS);
}

// ---- app ----
const app = express();
// No auth, so refuse anything not addressed to localhost (blocks DNS-rebinding pages).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (host === 'localhost' || host === '127.0.0.1') return next();
  res.status(403).end();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

const writes = fn => wrap(async (req, res) => {
  const out = await fn(req, res);
  scheduleSync();
  return out;
});

const taskId = req => {
  const id = Number(req.params.id);
  if (!store.getTask(id)) throw Object.assign(new Error('No such task'), { status: 404 });
  return id;
};

app.get('/api/board', wrap(() => {
  if (SYNC_ON && !pushTimer && Date.now() - lastPull > PULL_EVERY_MS) runSync();
  const tasks = store.board(14);
  return {
    tasks,
    brief: composeBrief(tasks),
    inbox: inbox.read(),
    unknownPeople: store.listPeople({ unknown: true }),
    sync: syncState,
    features: { claude: Boolean(process.env.ANTHROPIC_API_KEY), gmail: Boolean(process.env.GOOGLE_REFRESH_TOKEN) },
  };
}));

app.get('/api/tasks/:id', wrap(req => {
  const id = taskId(req);
  const task = store.getTask(id);
  return {
    task,
    log: store.getLog(id),
    person: store.findPerson({ email: task.person_email, name: task.person }) ?? null,
  };
}));

// Quick add is free text: same parsing as the inbox (person, company, Kieran for logistics).
app.post('/api/tasks', writes(async req => {
  const title = req.body.title?.trim();
  if (!title) throw new Error('Empty task');
  const { created } = await inbox.addFromFreeText([title], 'manual');
  return created[0];
}));

// Answer to "how do you know them?". Keyed by email or name so it replays cleanly across copies.
app.post('/api/people', writes(req => {
  const { email, name, relationship } = req.body;
  if (!store.RELATIONSHIPS.includes(relationship)) throw new Error('Pick a relationship');
  return store.upsertPerson({ email, name, relationship });
}));

app.post('/api/tasks/:id/status', writes(req => {
  const { status, reason } = req.body;
  if (status === 'done' && !reason?.trim()) throw new Error('A one-line reason is required');
  return store.setStatus(taskId(req), status, reason?.trim() || null);
}));

app.post('/api/tasks/:id/snooze', writes(req => store.snooze(taskId(req), req.body.due)));

app.post('/api/tasks/:id/chat', writes(async req => {
  const message = req.body.message?.trim();
  if (!message) throw new Error('Empty message');
  return claude.chat(taskId(req), message);
}));

app.post('/api/tasks/:id/gmail-draft', writes(async req => {
  const id = taskId(req);
  const task = store.getTask(id);
  const { to, subject, body } = req.body;
  if (!body?.trim()) throw new Error('Draft body is empty');
  const threadId = task.source_type === 'email' ? task.source_ref : null;
  const draft = await gmail.createDraft({ to, subject, body, threadId });
  store.addLog(id, 'note', `Gmail draft saved${draft.inThread ? ' in thread' : ''} (draft ${draft.id})`);
  return draft;
}));

app.put('/api/inbox', writes(req => {
  inbox.write(String(req.body.text ?? ''));
  return { ok: true };
}));

app.post('/api/inbox/process', writes(async () => {
  const created = await inbox.processInbox();
  return { created, inbox: inbox.read() };
}));

app.post('/api/sync', wrap(() => runSync()));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Commitments at http://localhost:${PORT}`);
  if (SYNC_ON) runSync();
});

// Push pending changes before exit.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (pushTimer) runSync();
    process.exit(0);
  });
}
