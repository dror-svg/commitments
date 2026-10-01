// Data layer. Plain SQL over better-sqlite3. Shared by cli.js and the dashboard server.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.COMMITMENTS_DB || path.join(__dirname, 'data', 'commitments.db');

// delegated = handed to Kieran (EA). Still open, tracked separately.
const STATUSES = ['new', 'active', 'waiting', 'delegated', 'done', 'dropped'];
const OPEN_STATUSES = ['new', 'active', 'waiting', 'delegated'];
const SQL_OPEN = `(${OPEN_STATUSES.map(s => `'${s}'`).join(',')})`;
const DIRECTIONS = ['i_owe', 'they_owe'];
const SOURCE_TYPES = ['email', 'meeting', 'slack', 'note', 'manual'];
const LOG_KINDS = ['created', 'note', 'draft', 'status_change', 'nudge', 'chat'];
const RELATIONSHIPS = ['lp', 'founder', 'partner', 'team', 'friend', 'other'];

const SCHEMA_VERSION = 1;

const TASKS_TABLE = name => `
CREATE TABLE ${name} (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  detail          TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','active','waiting','delegated','done','dropped')),
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
);`;

// People can exist before their email is known (free-text adds), so they get their own id.
// relationship NULL means "not asked yet"; the dashboard asks once.
const PEOPLE_TABLE = name => `
CREATE TABLE ${name} (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT UNIQUE COLLATE NOCASE,
  name         TEXT,
  company      TEXT,
  relationship TEXT CHECK (relationship IN ('lp','founder','partner','team','friend','other')),
  notes        TEXT
);`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_person_email ON tasks(person_email);
CREATE INDEX IF NOT EXISTS idx_people_name ON people(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id, ts);
`;

const TASK_LOG_TABLE = `
CREATE TABLE task_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts      TEXT NOT NULL,
  kind    TEXT NOT NULL
          CHECK (kind IN ('created','note','draft','status_change','nudge','chat')),
  body    TEXT
);`;

// v0 (Phase 1) -> v1: 'delegated' status, people keyed by id with company and nullable relationship.
// SQLite can't alter CHECK constraints, so both tables are rebuilt.
function migrate(d) {
  const version = d.pragma('user_version', { simple: true });
  const hasTasks = d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
  if (!hasTasks) {
    d.exec(TASKS_TABLE('tasks') + TASK_LOG_TABLE + PEOPLE_TABLE('people') + INDEXES);
    d.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (version >= SCHEMA_VERSION) return;
  d.pragma('foreign_keys = OFF');
  d.transaction(() => {
    d.exec(TASKS_TABLE('tasks_v1'));
    d.exec('INSERT INTO tasks_v1 SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_v1 RENAME TO tasks;');
    d.exec(PEOPLE_TABLE('people_v1'));
    d.exec(`INSERT INTO people_v1 (email, name, relationship, notes) SELECT email, name, relationship, notes FROM people;
            DROP TABLE people; ALTER TABLE people_v1 RENAME TO people;`);
    d.exec(INDEXES);
    d.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
  d.pragma('foreign_keys = ON');
}

let _db;
function close() {
  if (_db) _db.close();
  _db = undefined;
}

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  // The .db file is committed to git, so keep everything in the one file (no -wal/-shm sidecars).
  _db.pragma('journal_mode = DELETE');
  migrate(_db);
  _db.pragma('foreign_keys = ON');
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

// tasks.person is a display string, "Name (Company)" when the company is known.
function splitPerson(label) {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(label || '');
  return m ? { name: m[1].trim(), company: m[2].trim() } : { name: (label || '').trim() || null, company: null };
}

function personLabel(name, company) {
  if (!name) return null;
  return company && !/\(/.test(name) ? `${name} (${company})` : name;
}

// By email when there is one, else by name (case-insensitive, company ignored).
// With an email that isn't on file, only an email-less person of that name matches,
// so two people who share a name but have different emails stay separate.
function findPerson({ email, name } = {}) {
  const d = db();
  if (email) {
    const p = d.prepare('SELECT * FROM people WHERE email = ?').get(email);
    if (p) return p;
  }
  const n = splitPerson(name).name;
  if (!n) return undefined;
  return d.prepare(`SELECT * FROM people WHERE name = ? COLLATE NOCASE ${email ? 'AND email IS NULL' : ''}
                    ORDER BY id LIMIT 1`).get(n);
}

// Merges into an existing person (filling blanks) or creates one. relationship only changes when given.
function upsertPerson({ email, name, company, relationship, notes }) {
  check(relationship, RELATIONSHIPS, 'relationship');
  const parsed = splitPerson(name);
  name = parsed.name;
  company = company || parsed.company;
  email = email ? email.toLowerCase() : null;
  if (!email && !name) return null;
  const d = db();
  const existing = findPerson({ email, name });
  if (existing) {
    d.prepare(`UPDATE people SET
        email = COALESCE(email, @email), name = COALESCE(name, @name), company = COALESCE(company, @company),
        relationship = COALESCE(@relationship, relationship), notes = COALESCE(@notes, notes)
      WHERE id = @id`).run({ id: existing.id, email, name, company: company ?? null,
      relationship: relationship ?? null, notes: notes ?? null });
    return d.prepare('SELECT * FROM people WHERE id = ?').get(existing.id);
  }
  const { lastInsertRowid } = d.prepare(`INSERT INTO people (email, name, company, relationship, notes)
    VALUES (?, ?, ?, ?, ?)`).run(email, name, company ?? null, relationship ?? null, notes ?? null);
  return d.prepare('SELECT * FROM people WHERE id = ?').get(lastInsertRowid);
}

const getPerson = email => findPerson({ email });

function listPeople({ unknown = false } = {}) {
  return db().prepare(`SELECT * FROM people ${unknown ? 'WHERE relationship IS NULL' : ''}
                       ORDER BY relationship, name`).all();
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
    person: personLabel(f.person, f.company) ?? null,
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
    if (row.person_email || row.person) upsertPerson({ email: row.person_email, name: row.person });
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
  if (fields.company) {
    const name = splitPerson(sets.person ?? mustGetTask(id).person).name;
    if (name) sets.person = personLabel(name, fields.company);
  }
  const keys = Object.keys(sets);
  if (!keys.length) return getTask(id);
  const d = db();
  return d.transaction(() => {
    d.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id });
    if (sets.person || sets.person_email) {
      const t = getTask(id);
      upsertPerson({ email: t.person_email, name: t.person });
    }
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
  const where = [`status IN ${SQL_OPEN}`];
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

// Open tasks plus anything closed in the last `days` days, each with its person's relationship.
// Feeds the dashboard and the brief.
function board(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const tasks = db().prepare(`SELECT * FROM tasks WHERE status IN ${SQL_OPEN} OR closed_at >= ?
                              ORDER BY last_touched_at ASC`).all(since);
  for (const t of tasks) {
    const p = (t.person_email || t.person) && findPerson({ email: t.person_email, name: t.person });
    t.person_relationship = p?.relationship ?? null;
  }
  return tasks;
}

// Every mutation made through the exported API is appended to a journal next to the DB.
// sync.js replays it on top of the remote copy when local and remote have both changed,
// then clears it once the push lands. Internal calls inside this file are not journaled.
const JOURNAL_PATH = `${DB_PATH}.pending.jsonl`;
let journalOn = true;

function journaled(op, fn) {
  return (...args) => {
    const result = fn(...args);
    if (journalOn) {
      const entry = { op, args, ts: now() };
      if (op === 'addTask') entry.resultId = result.id;
      fs.appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + '\n');
    }
    return result;
  };
}

function readJournal() {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  return fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function clearJournal() {
  fs.rmSync(JOURNAL_PATH, { force: true });
}

// Re-applies journal entries to the current DB. Task ids created locally are remapped,
// since the remote may have used those ids already. The journal is rewritten with the new
// ids so later entries line up if the push fails and this runs again. Returns failures.
function replayJournal(entries) {
  const ops = { addTask, updateTask, setStatus, snooze, addLog, upsertPerson };
  const idMap = new Map();
  const failed = [];
  const rewritten = [];
  journalOn = false;
  try {
    for (const e of entries) {
      try {
        const args = [...e.args];
        const takesTaskId = !['addTask', 'upsertPerson'].includes(e.op);
        if (takesTaskId && idMap.has(args[0])) args[0] = idMap.get(args[0]);
        const r = db().transaction(() => ops[e.op](...args))();
        if (e.op === 'addTask') idMap.set(e.resultId, r.id);
        rewritten.push({ ...e, args, ...(e.op === 'addTask' ? { resultId: r.id } : {}) });
      } catch (err) {
        failed.push({ ...e, error: err.message });
      }
    }
  } finally {
    journalOn = true;
  }
  fs.writeFileSync(JOURNAL_PATH, rewritten.map(e => JSON.stringify(e) + '\n').join(''));
  return failed;
}

module.exports = {
  db, close, DB_PATH, STATUSES, OPEN_STATUSES, DIRECTIONS, SOURCE_TYPES, LOG_KINDS, RELATIONSHIPS,
  addTask: journaled('addTask', addTask),
  updateTask: journaled('updateTask', updateTask),
  setStatus: journaled('setStatus', setStatus),
  snooze: journaled('snooze', snooze),
  addLog: journaled('addLog', addLog),
  upsertPerson: journaled('upsertPerson', upsertPerson),
  getTask, listTasks, getLog, findOpen, findBySourceRef, getPerson, findPerson, listPeople, parseDate, board,
  splitPerson, personLabel,
  readJournal, clearJournal, replayJournal,
};
