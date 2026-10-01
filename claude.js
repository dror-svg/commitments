// Claude calls: the per-task chat and inbox parsing. System prompt always starts with CLAUDE.md.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const store = require('./db');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium';
const USER_PREFIX = 'Dror: ';

let _client;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  return (_client ??= new Anthropic());
}

const styleGuide = () => fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8');

async function call({ output_config, ...params }) {
  const res = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT, ...output_config },
    // On a safety decline, the API reruns the request on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...params,
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

const DRAFT_RULES = `When an email is needed, write it. Put the email inside a single tag like this:
<draft to="address@example.com" subject="Subject line">
body of the email
</draft>
Leave subject empty when replying in the existing thread. Use the task's person_email as "to" unless told otherwise. One draft per reply at most. Outside the tag, say at most one short sentence, or nothing. Never claim to have sent anything; drafts are saved to Gmail only when Dror clicks the button.`;

// task_log stores both sides of the chat as kind=chat. Dror's turns carry USER_PREFIX.
function chatHistory(log) {
  const msgs = [];
  for (const e of log.filter(e => e.kind === 'chat')) {
    const isUser = e.body.startsWith(USER_PREFIX);
    const role = isUser ? 'user' : 'assistant';
    const content = isUser ? e.body.slice(USER_PREFIX.length) : e.body;
    if (msgs.length && msgs.at(-1).role === role) msgs.at(-1).content += `\n\n${content}`;
    else msgs.push({ role, content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function taskContext(task, log, person) {
  const { person_relationship, ...row } = task;
  const lines = log.filter(e => e.kind !== 'chat').map(e => `${e.ts.slice(0, 16)} ${e.kind}: ${e.body ?? ''}`);
  return [
    `Today is ${new Date().toDateString()}.`,
    `You are helping Dror close one commitment. Stay on this task.`,
    `\nTask row:\n${JSON.stringify(row, null, 2)}`,
    person ? `\nPerson:\n${JSON.stringify(person, null, 2)}` : '',
    `\nSource excerpt (verbatim):\n${task.source_excerpt || '(none)'}`,
    `\nTask log:\n${lines.join('\n') || '(empty)'}`,
    `\n${DRAFT_RULES}`,
  ].join('\n');
}

function parseDraft(text) {
  const m = /<draft\b([^>]*)>([\s\S]*?)<\/draft>/i.exec(text);
  if (!m) return null;
  const attr = name => (new RegExp(`${name}="([^"]*)"`).exec(m[1]) || [])[1] || '';
  return { to: attr('to'), subject: attr('subject'), body: m[2].trim() };
}

async function chat(taskId, message) {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`No task with id ${taskId}`);
  store.addLog(taskId, 'chat', USER_PREFIX + message);
  const log = store.getLog(taskId);
  const person = task.person_email ? store.getPerson(task.person_email) : null;

  const reply = await call({
    system: [
      { type: 'text', text: styleGuide(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: taskContext(task, log, person) },
    ],
    messages: chatHistory(log),
  });

  store.addLog(taskId, 'chat', reply);
  const draft = parseDraft(reply);
  if (draft) store.addLog(taskId, 'draft', `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`);
  return { reply, draft };
}

const INBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'title', 'person', 'person_email', 'direction', 'due_at', 'detail'],
        properties: {
          line: { type: 'string', description: 'The inbox line this came from, verbatim' },
          title: { type: 'string', description: 'Short imperative title, e.g. "Send Q3 deck to Maya"' },
          person: { type: ['string', 'null'] },
          person_email: { type: ['string', 'null'] },
          direction: { type: 'string', enum: ['i_owe', 'they_owe'] },
          due_at: { type: ['string', 'null'], description: 'YYYY-MM-DD if a date is stated or clearly implied' },
          detail: { type: ['string', 'null'] },
        },
      },
    },
  },
};

// Turns free-form inbox lines into task fields. Falls back to one task per line, verbatim.
async function parseInboxLines(lines) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return lines.map(line => ({ line, title: line, direction: 'i_owe' }));
  }
  const people = store.listPeople().map(p => `${p.name ?? ''} <${p.email}> ${p.relationship}`).join('\n');
  const text = await call({
    system: [
      { type: 'text', text: styleGuide(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `Today is ${new Date().toISOString().slice(0, 10)}. Turn each inbox line into one task. Keep Dror's meaning; do not invent people, emails, or dates. direction is they_owe only when someone else owes Dror. Known people:\n${people || '(none)'}` },
    ],
    messages: [{ role: 'user', content: lines.join('\n') }],
    output_config: { format: { type: 'json_schema', schema: INBOX_SCHEMA } },
  });
  return JSON.parse(text).tasks;
}

module.exports = { chat, parseDraft, parseInboxLines, USER_PREFIX, MODEL };
