#!/usr/bin/env node
// CLI over db.js. The dashboard is the main surface; the sweep drives this.
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const { parseArgs } = require('util');
const store = require('./db');

const USAGE = `Usage: node cli.js <command> [args] [--json]

  add "text" [--person NAME] [--company CO] [--email ADDR] [--direction i_owe|they_owe]
             [--source email|meeting|slack|note|manual] [--ref SOURCE_REF]
             [--excerpt "verbatim sentence"] [--detail TEXT] [--due DATE] [--status STATUS]
  list [status|open|all]          default: open (new, active, waiting)
  show <id>                       task row plus its log
  log <id>                        the log only
  done <id> "reason"
  drop <id> "reason"
  status <id> <new|active|waiting|delegated>
  delegate <id>                   hand to Kieran (status delegated)
  snooze <id> <DATE>              DATE is YYYY-MM-DD, ISO, or +Nd
  note <id> "text" [--kind note|draft|nudge|chat]
  update <id> [--title ..] [--person ..] [--email ..] [--direction ..] [--due ..] ...
  find [--person NAME] [--email ADDR] [--q "words"] [--ref SOURCE_REF]
                                  open tasks for dedupe (--ref searches all statuses)
  person <email|"Full Name"> [--name NAME] [--company CO] [--rel lp|founder|partner|team|friend|other] [--notes TEXT]
  people [--unknown]              --unknown: people whose relationship hasn't been set
  brief                           today's brief paragraph (--json adds owe: open items on you)
  process-inbox                   turn inbox.md lines into tasks (keeps "?" lines)
  sync ["commit message"]         pull, replay local changes, commit data, push`;

const { values: o, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    person: { type: 'string' }, email: { type: 'string' }, direction: { type: 'string' },
    source: { type: 'string' }, ref: { type: 'string' }, excerpt: { type: 'string' },
    detail: { type: 'string' }, due: { type: 'string' }, status: { type: 'string' },
    title: { type: 'string' }, kind: { type: 'string' }, q: { type: 'string' },
    name: { type: 'string' }, rel: { type: 'string' }, notes: { type: 'string' },
    company: { type: 'string' }, unknown: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const days = iso => Math.floor((Date.now() - new Date(iso)) / 86400000);
const short = iso => (iso ? iso.slice(0, 10) : '');

function line(t) {
  const stale = days(t.last_touched_at);
  const who = t.person ? ` · ${t.person}` : '';
  const dir = t.direction === 'they_owe' ? ' [they owe]' : '';
  const due = t.due_at ? ` · due ${short(t.due_at)}` : '';
  const mark = stale >= 5 && store.OPEN_STATUSES.includes(t.status) ? ` · ${stale}d stale` : '';
  return `#${t.id} [${t.status}] ${t.title}${who}${dir}${due}${mark}`;
}

function personLine(p) {
  const who = [p.name, p.company && `(${p.company})`].filter(Boolean).join(' ');
  console.log([who || '?', p.email, p.relationship ?? 'relationship not set', p.notes].filter(Boolean).join(' · '));
}

function printTask(t) {
  console.log(line(t));
  for (const k of ['detail', 'person_email', 'source_type', 'source_ref', 'source_excerpt',
    'captured_at', 'last_touched_at', 'closed_at', 'close_reason']) {
    if (t[k]) console.log(`  ${k}: ${t[k]}`);
  }
}

function printLog(entries) {
  for (const e of entries) console.log(`  ${e.ts.replace('T', ' ').slice(0, 16)}  ${e.kind.padEnd(13)} ${e.body ?? ''}`);
}

function out(data, human) {
  if (o.json) console.log(JSON.stringify(data, null, 2));
  else human(data);
}

function id() {
  const n = Number(args[0]);
  if (!Number.isInteger(n)) throw new Error('Expected a task id');
  return n;
}

function taskFields() {
  const f = {};
  if (o.title !== undefined) f.title = o.title;
  if (o.detail !== undefined) f.detail = o.detail;
  if (o.direction !== undefined) f.direction = o.direction;
  if (o.person !== undefined) f.person = o.person;
  if (o.company !== undefined) f.company = o.company;
  if (o.email !== undefined) f.person_email = o.email;
  if (o.source !== undefined) f.source_type = o.source;
  if (o.ref !== undefined) f.source_ref = o.ref;
  if (o.excerpt !== undefined) f.source_excerpt = o.excerpt;
  if (o.due !== undefined) f.due_at = o.due;
  return f;
}

const commands = {
  add() {
    const title = args.join(' ');
    out(store.addTask({ ...taskFields(), title, status: o.status }), printTask);
  },
  list() {
    const ts = store.listTasks(args[0] || 'open');
    out(ts, rows => (rows.length ? rows.forEach(t => console.log(line(t))) : console.log('Nothing.')));
  },
  show() {
    const t = store.getTask(id());
    if (!t) throw new Error(`No task with id ${args[0]}`);
    out({ ...t, log: store.getLog(t.id) }, d => { printTask(d); console.log('  log:'); printLog(d.log); });
  },
  log() {
    const tid = id();
    if (!store.getTask(tid)) throw new Error(`No task with id ${tid}`);
    out(store.getLog(tid), printLog);
  },
  done() { out(store.setStatus(id(), 'done', args.slice(1).join(' ') || null), t => console.log(line(t))); },
  drop() { out(store.setStatus(id(), 'dropped', args.slice(1).join(' ') || null), t => console.log(line(t))); },
  status() {
    const s = args[1];
    if (!['new', 'active', 'waiting', 'delegated'].includes(s)) throw new Error('status must be new, active, waiting, or delegated (use done/drop to close)');
    out(store.setStatus(id(), s), t => console.log(line(t)));
  },
  snooze() { out(store.snooze(id(), args[1]), t => console.log(line(t))); },
  note() {
    const tid = id();
    store.getTask(tid) || (() => { throw new Error(`No task with id ${tid}`); })();
    store.addLog(tid, o.kind || 'note', args.slice(1).join(' '));
    out(store.getTask(tid), t => console.log(line(t)));
  },
  update() { out(store.updateTask(id(), taskFields()), printTask); },
  find() {
    const rows = o.ref ? store.findBySourceRef(o.ref) : store.findOpen({ person: o.person, email: o.email, q: o.q });
    out(rows, r => (r.length ? r.forEach(t => console.log(line(t))) : console.log('No match.')));
  },
  person() {
    if (!args[0]) throw new Error('Expected an email or a name');
    const byEmail = args[0].includes('@');
    const p = store.upsertPerson({
      email: byEmail ? args[0] : undefined, name: byEmail ? o.name : (o.name ?? args[0]),
      company: o.company, relationship: o.rel, notes: o.notes,
    });
    out(p, personLine);
  },
  people() {
    out(store.listPeople({ unknown: o.unknown }), ps => (ps.length ? ps.forEach(personLine) : console.log('Nobody.')));
  },
  delegate() { out(store.setStatus(id(), 'delegated', 'to Kieran'), t => console.log(line(t))); },
  brief() {
    const { composeBrief, oweCount } = require('./brief');
    out({ brief: composeBrief(), owe: oweCount() }, d => console.log(d.brief));
  },
  async 'process-inbox'() {
    const created = await require('./inbox').processInbox();
    out(created, rows => (rows.length ? rows.forEach(t => console.log(line(t))) : console.log('Inbox empty.')));
  },
  sync() {
    const r = require('./sync').sync(args[0] ? { message: args[0] } : {});
    out(r, x => console.log(x.ok ? x.action : `${x.action}: ${x.message}`));
    if (!r.ok && r.action === 'paused') process.exitCode = 1;
  },
};

if (o.help || !cmd || !commands[cmd]) {
  console.log(USAGE);
  process.exit(cmd && !o.help && !commands[cmd] ? 1 : 0);
}

Promise.resolve().then(() => commands[cmd]()).catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
