// inbox.md: raw capture, one commitment per line.
// Lines starting with "?" are the sweep's unconfirmed guesses. They stay put until
// you delete the "?" (confirm) or the line (reject). Lines starting with "#" are ignored.
const fs = require('fs');
const path = require('path');
const store = require('./db');
const { parseFreeText } = require('./claude');

const INBOX_PATH = path.join(__dirname, 'inbox.md');

const read = () => (fs.existsSync(INBOX_PATH) ? fs.readFileSync(INBOX_PATH, 'utf8') : '');
const write = text => fs.writeFileSync(INBOX_PATH, text);

function split(text) {
  const keep = [], todo = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (!line) continue;
    if (line.startsWith('?') || line.startsWith('#')) keep.push(raw.trim());
    else todo.push(line);
  }
  return { keep, todo };
}

// Free text to tasks. Person and company go into the person field, logistics start with Kieran.
async function addFromFreeText(lines, source_type) {
  const parsed = await parseFreeText(lines);
  const created = parsed.map(p => store.addTask({
    title: p.title,
    detail: p.detail,
    person: p.person,
    company: p.company,
    person_email: p.person_email,
    direction: p.direction,
    due_at: p.due_at,
    status: p.delegate ? 'delegated' : 'new',
    source_type,
    source_excerpt: p.line,
  }));
  return { parsed, created };
}

// Returns the tasks created. Unconfirmed "?" lines are left in the file.
async function processInbox() {
  const { keep, todo } = split(read());
  if (!todo.length) return [];
  const { parsed, created } = await addFromFreeText(todo, 'note');
  // Anything the parser didn't account for stays in the file rather than vanishing.
  const handled = new Set(parsed.map(p => p.line.trim()));
  const rest = [...keep, ...todo.filter(l => !handled.has(l))];
  write(rest.length ? rest.join('\n') + '\n' : '');
  return created;
}

module.exports = { read, write, processInbox, addFromFreeText, INBOX_PATH };
