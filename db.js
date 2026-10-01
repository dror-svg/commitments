// Data layer. Plain SQL over better-sqlite3. Shared by cli.js and (later) the dashboard server.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.COMMITMENTS_DB || path.join(__dirname, 'data', 'commitments.db');

const STATUSES = ['new', 'active', 'waiting', 'done', 'dropped'];
const OPEN_STATUSES = ['new', 'active', 'waiting'];
const DIRECTIONS = ['i_owe', 'they_owe'];
const SOURCE_TYPES = ['email', 'meeting', 'slack', 'note', 'manual'];
const LOG_KINDS = ['created', 'note', 'draft', 'status_change', 'nudge', 'chat'];
const RELATIONSHIPS = ['lp', 'founder', 'partner', 'team', 'friend', 'other'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  detail          TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','active','waiting','done','dropped')),
  direction       TEXT NOT NULL DEFAULT 'i_owe'
                  CHECK (direction IN ('i_owe','they_owe')),
  person          TEXT,
  person_email    TEXT,
  source_type     TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source_type IN ('email','meeting','slack','note','manual')),
  source_ref      TEXT,
  source_excerpt  TEXT,
  captured_at     TEXT NOT NULL,
  due_at          TEXT,
  last_touched_at TEXT NOT NULL,
  closed_at       TEXT,
  close_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_person_email ON tasks(person_email);

CREATE TABLE IF NOT EXISTS task_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts      TEXT NOT NULL,
  kind    TEXT NOT NULL
          CHECK (kind IN ('created','note','draft','status_change','nudge','chat')),
  body    TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id, ts);

CREATE TABLE IF NOT EXISTS people (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  name         TEXT,
  relationship TEXT NOT NULL DEFAULT 'other'
               CHECK (relationship IN ('lp','founder','partner','team','friend','other')),
  notes        TEXT
);
`;

let _db;
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  // The .db file is committed to git, so keep everything in the one file (no -wal/-shm sidecars).
  _db.pragma('journal_mode = DELETE');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}

const now = () => new Date().toISOString();

// Accepts YYYY-MM-DD, full ISO, or relative "+3d". Returns ISO string or null.
function parseDate(s) {
  if (s == null || s === '') return null;
  const rel = /^\+(\d+)d$/.exec(s);
  if (rel) return new Date(Date.now() + Number(rel[1]) * 86400000).toISOString();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T17:00:00` : s);
  if (isNaN(d)) throw new Error(`Bad date: ${s}`);
  return d.toISOString();
}

function check(value, allowed, field) {
  if (value != null && !allowed.includes(value)) {
    throw new Error(`Invalid ${field} "${value}". Allowed: ${allowed.join(', ')}`);
  }
}

function getTask(id) {
  return db().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function mustGetTask(id) {
  const t = getTask(id);
  if (!t) throw new Error(`No task with id ${id}`);
  return t;
}

function addLog(taskId, kind, body, ts = now()) {
  check(kind, LOG_KINDS, 'kind');
  const d = db();
  d.prepare('INSERT INTO task_log (task_id, ts, kind, body) VALUES (?, ?, ?, ?)').run(taskId, ts, kind, body ?? null);
  d.prepare('UPDATE tasks SET last_touched_at = ? WHERE id = ?').run(ts, taskId);
}

function upsertPerson({ email, name, relationship, notes }) {
  if (!email) return;
  check(relationship, RELATIONSHIPS, 'relationship');
  db().prepare(`
    INSERT INTO people (email, name, relationship, notes)
    VALUES (@email, @name, COALESCE(@relationship, 'other'), @notes)
    ON CONFLICT(email) DO UPDATE SET
      name         = COALESCE(excluded.name, people.name),
      relationship = CASE WHEN @relationship IS NULL THEN people.relationship ELSE excluded.relationship END,
      notes        = COALESCE(excluded.notes, people.notes)
  `).run({ email, name: name ?? null, relationship: relationship ?? null, notes: notes ?? null });
}

function getPerson(email) {
  return db().prepare('SELECT * FROM people WHERE email = ?').get(email);
}

function listPeople() {
  return db().prepare('SELECT * FROM people ORDER BY relationship, name').all();
}

function addTask(f) {
  if (!f.title || !f.title.trim()) throw new Error('title is required');
  check(f.status, STATUSES, 'status');
  check(f.direction, DIRECTIONS, 'direction');
  check(f.source_type, SOURCE_TYPES, 'source_type');
  const ts = now();
  const row = {
    title: f.title.trim(),
    detail: f.detail ?? null,
    status: f.status ?? 'new',
    direction: f.direction ?? 'i_owe',
    person: f.person ?? null,
    person_email: f.person_email ? f.person_email.toLowerCase() : null,
    source_type: f.source_type ?? 'manual',
    source_ref: f.source_ref ?? null,
    source_excerpt: f.source_excerpt ?? null,
    captured_at: f.captured_at ? parseDate(f.captured_at) : ts,
    due_at: parseDate(f.due_at),
    last_touched_at: ts,
  };
  const d = db();
  return d.transaction(() => {
    const { lastInsertRowid } = d.prepare(`
      INSERT INTO tasks (title, detail, status, direction, person, person_email, source_type,
                         source_ref, source_excerpt, captured_at, due_at, last_touched_at)
      VALUES (@title, @detail, @status, @direction, @person, @person_email, @source_type,
              @source_ref, @source_excerpt, @captured_at, @due_at, @last_touched_at)
    `).run(row);
    if (row.person_email) upsertPerson({ email: row.person_email, name: row.person });
    addLog(lastInsertRowid, 'created', `${row.source_type}${row.source_ref ? ` ${row.source_ref}` : ''}`, ts);
    return getTask(lastInsertRowid);
  })();
}

const EDITABLE = ['title', 'detail', 'direction', 'person', 'person_email', 'source_type',
  'source_ref', 'source_excerpt', 'due_at'];

function updateTask(id, fields) {
  mustGetTask(id);
  check(fields.direction, DIRECTIONS, 'direction');
  check(fields.source_type, SOURCE_TYPES, 'source_type');
  const sets = {};
  for (const k of EDITABLE) if (k in fields) sets[k] = k === 'due_at' ? parseDate(fields[k]) : fields[k];
  const keys = Object.keys(sets);
  if (!keys.length) return getTask(id);
  const d = db();
  return d.transaction(() => {
    d.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id });
    addLog(id, 'note', `updated ${keys.join(', ')}`);
    return getTask(id);
  })();
}

function setStatus(id, status, reason) {
  check(status, STATUSES, 'status');
  const t = mustGetTask(id);
  const closing = status === 'done' || status === 'dropped';
  const d = db();
  return d.transaction(() => {
    d.prepare(`UPDATE tasks SET status = ?, closed_at = ?, close_reason = ? WHERE id = ?`)
      .run(status, closing ? now() : null, closing ? (reason ?? null) : null, id);
    addLog(id, 'status_change', `${t.status} -> ${status}${reason ? `: ${reason}` : ''}`);
    return getTask(id);
  })();
}

function snooze(id, due) {
  mustGetTask(id);
  const due_at = parseDate(due);
  const d = db();
  return d.transaction(() => {
    d.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(due_at, id);
    addLog(id, 'status_change', `snoozed to ${due_at}`);
    return getTask(id);
  })();
}

// Default: open tasks. Pass a status, 'open', or 'all'.
function listTasks(status = 'open') {
  const d = db();
  if (status === 'all') return d.prepare('SELECT * FROM tasks ORDER BY last_touched_at ASC').all();
  const statuses = status === 'open' ? OPEN_STATUSES : [status];
  statuses.forEach(s => check(s, STATUSES, 'status'));
  return d.prepare(`SELECT * FROM tasks WHERE status IN (${statuses.map(() => '?').join(',')})
                    ORDER BY last_touched_at ASC`).all(...statuses);
}

function getLog(id) {
  return db().prepare('SELECT * FROM task_log WHERE task_id = ? ORDER BY ts ASC, id ASC').all(id);
}

// Loose lookup for sweep dedupe: open tasks matching a person/email and/or words in the title or excerpt.
function findOpen({ person, email, q } = {}) {
  const where = [`status IN ('new','active','waiting')`];
  const params = {};
  if (email) { where.push('person_email = @email COLLATE NOCASE'); params.email = email; }
  if (person) { where.push('person LIKE @person'); params.person = `%${person}%`; }
  if (q) {
    q.split(/\s+/).filter(Boolean).forEach((w, i) => {
      where.push(`(title LIKE @q${i} OR detail LIKE @q${i} OR source_excerpt LIKE @q${i})`);
      params[`q${i}`] = `%${w}%`;
    });
  }
  return db().prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY last_touched_at ASC`).all(params);
}

function findBySourceRef(ref) {
  return db().prepare('SELECT * FROM tasks WHERE source_ref = ?').all(ref);
}

module.exports = {
  db, DB_PATH, STATUSES, OPEN_STATUSES, DIRECTIONS, SOURCE_TYPES, LOG_KINDS, RELATIONSHIPS,
  addTask, updateTask, setStatus, snooze, getTask, listTasks, getLog, addLog,
  findOpen, findBySourceRef, upsertPerson, getPerson, listPeople, parseDate,
};
