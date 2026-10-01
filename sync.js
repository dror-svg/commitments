// GitHub sync for the data files. The dashboard and the cloud sweep both write the DB,
// and a binary SQLite file can't be merged by git. So: take the remote copy, replay the
// local journal (db.js) on top of it, merge inbox.md line by line, commit, push.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./db');

const ROOT = __dirname;
const DB_REL = path.relative(ROOT, store.DB_PATH);
const INBOX_REL = 'inbox.md';
const DATA_FILES = [DB_REL, INBOX_REL];
// Written only by the sweep. Committed alongside the data, never rebuilt.
const SWEEP_FILES = ['data/brief.md', 'data/last_sweep.txt'];

const committable = () => [...DATA_FILES, ...SWEEP_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))];

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(...args) {
  try { return git(...args); } catch { return null; }
}

function show(rev, file) {
  return tryGit('show', `${rev}:${file}`) ?? '';
}

// Line-level 3-way merge: keep the remote's lines, drop ones deleted locally, add ones added locally.
function mergeInbox(base, local, remote) {
  const lines = s => s.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const b = new Set(lines(base)), l = new Set(lines(local)), r = lines(remote);
  const deleted = [...b].filter(x => !l.has(x));
  const added = [...l].filter(x => !b.has(x) && !r.includes(x));
  const out = [...r.filter(x => !deleted.includes(x)), ...added];
  return out.length ? out.join('\n') + '\n' : '';
}

function dataDirty() {
  return git('status', '--porcelain', '--', ...committable()) !== '';
}

// Returns { ok, action, message }. Synchronous on purpose: no writes can land mid-sync.
function sync({ message = 'sync: dashboard' } = {}) {
  if (!tryGit('rev-parse', '--is-inside-work-tree')) return { ok: false, action: 'none', message: 'not a git repo' };
  if (!tryGit('remote', 'get-url', 'origin')) return { ok: false, action: 'none', message: 'no origin remote' };
  if (DB_REL.startsWith('..')) return { ok: false, action: 'none', message: 'DB is outside the repo' };

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  let action = 'up to date';

  for (let attempt = 0; attempt < 3; attempt++) {
    const fetched = tryGit('fetch', '-q', 'origin', branch) !== null;
    const remote = fetched ? tryGit('rev-parse', `origin/${branch}`) : null;
    const head = git('rev-parse', 'HEAD');

    if (remote && remote !== head && tryGit('merge-base', '--is-ancestor', remote, head) === null) {
      // Remote has commits we don't. Rebuild data on top of them.
      const journal = store.readJournal();
      const localInbox = fs.existsSync(path.join(ROOT, INBOX_REL)) ? fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8') : '';
      const inbox = mergeInbox(show('HEAD', INBOX_REL), localInbox, show(remote, INBOX_REL));
      const backup = `${store.DB_PATH}.bak`;
      store.close();
      fs.copyFileSync(store.DB_PATH, backup);
      try {
        git('checkout', 'HEAD', '--', ...DATA_FILES);
        if (tryGit('merge', '--no-edit', '-q', remote) === null) {
          const conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
          if (conflicted.some(f => !DATA_FILES.includes(f) && !SWEEP_FILES.includes(f))) {
            tryGit('merge', '--abort');
            throw new Error(`merge conflict outside data files: ${conflicted.join(', ')}`);
          }
          // DB and inbox: take theirs, local changes come back via replay and mergeInbox.
          // Sweep files: keep ours, they were just written.
          const theirs = conflicted.filter(f => DATA_FILES.includes(f));
          const ours = conflicted.filter(f => SWEEP_FILES.includes(f));
          if (theirs.length) git('checkout', '--theirs', '--', ...theirs);
          if (ours.length) git('checkout', '--ours', '--', ...ours);
          git('add', '--', ...conflicted);
          git('commit', '--no-edit', '-q');
        }
        const failed = store.replayJournal(journal);
        if (failed.length) console.warn(`sync: ${failed.length} journal entries could not be replayed`, failed);
        fs.writeFileSync(path.join(ROOT, INBOX_REL), inbox);
        fs.rmSync(backup, { force: true });
        action = 'pulled';
      } catch (e) {
        store.close();
        fs.copyFileSync(backup, store.DB_PATH);
        fs.writeFileSync(path.join(ROOT, INBOX_REL), localInbox);
        return { ok: false, action: 'paused', message: e.message };
      }
    }

    if (dataDirty()) {
      store.close(); // flush and release before git reads the file
      const files = committable();
      git('add', '--', ...files);
      git('commit', '-q', '-m', message, '--', ...files);
    }

    const ahead = remote ? tryGit('rev-list', '--count', `${remote}..HEAD`) : '1';
    if (ahead === '0') {
      store.clearJournal();
      return { ok: true, action, message: '' };
    }
    if (tryGit('push', '-q', 'origin', `HEAD:${branch}`) !== null) {
      store.clearJournal();
      return { ok: true, action: action === 'pulled' ? 'pulled and pushed' : 'pushed', message: '' };
    }
    // Push rejected: someone pushed in between. Loop and rebuild on the new remote.
  }
  return { ok: false, action: 'paused', message: 'push kept getting rejected' };
}

module.exports = { sync, mergeInbox };
