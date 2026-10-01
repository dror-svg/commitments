// Today's brief: one plain paragraph. What's due, what's stale, what closed since yesterday.
// Deterministic so it can regenerate on every dashboard load at no cost.
const store = require('./db');

const DAY = 86400000;
const STALE_DAYS = 5;
const PRIORITY = { lp: 0, founder: 1 };

const rank = t => PRIORITY[t.person_relationship] ?? 2;
const daysSince = iso => Math.floor((Date.now() - new Date(iso)) / DAY);

function words(n) {
  return ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
}

function list(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

// Titles read mid-sentence, so "Send Sam the deck" becomes "send Sam the deck".
// Leaves acronyms ("Q3", "LP") and a leading person's name alone.
function lowerFirst(title, person) {
  const m = /^([A-Z][a-z']+)\b/.exec(title);
  if (!m || m[1] === person?.split(' ')[0]) return title;
  return title[0].toLowerCase() + title.slice(1);
}

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

// notes go in the same parentheses as the LP marker, e.g. "(LP, 2 days overdue)".
function name(t, notes = []) {
  const first = t.person?.split(' ')[0];
  const named = first && t.title.toLowerCase().includes(first.toLowerCase());
  const who = t.person && !named ? ` ${t.direction === 'they_owe' ? 'from' : 'for'} ${t.person}` : '';
  const tags = [t.person_relationship === 'lp' && 'LP', ...notes].filter(Boolean);
  return `${lowerFirst(t.title, t.person)}${who}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

function dueLabel(t, todayEnd) {
  const due = new Date(t.due_at);
  if (due < Date.now()) {
    const d = daysSince(t.due_at);
    return d === 0 ? 'due earlier today' : `${d} day${d === 1 ? '' : 's'} overdue`;
  }
  return due <= todayEnd ? 'due today' : 'due tomorrow';
}

// What's on Dror himself: open, i_owe, not parked waiting on someone, not with Kieran.
const isMine = t => t.direction === 'i_owe' && ['new', 'active'].includes(t.status);

// CLAUDE.md priority: LP, then founder, then everyone else. Within a tier, the most
// urgent due date first (overdue or due by tomorrow), then the stalest.
function byPriority(tomorrowEnd) {
  const urgent = t => (t.due_at && new Date(t.due_at) <= tomorrowEnd ? 0 : 1);
  return (a, b) => rank(a) - rank(b)
    || urgent(a) - urgent(b)
    || (urgent(a) === 0 ? new Date(a.due_at) - new Date(b.due_at) : 0)
    || new Date(a.last_touched_at) - new Date(b.last_touched_at);
}

function composeBrief(tasks = store.board(), now = new Date()) {
  const open = tasks.filter(t => store.OPEN_STATUSES.includes(t.status));
  const mine = open.filter(isMine);
  const delegated = open.filter(t => t.status === 'delegated');
  const waiting = open.filter(t => t.status === 'waiting' || (t.direction === 'they_owe' && t.status !== 'delegated'));
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const tomorrowEnd = new Date(todayEnd.getTime() + DAY);
  const order = byPriority(tomorrowEnd);

  const due = open.filter(t => t.status !== 'delegated' && t.due_at && new Date(t.due_at) <= tomorrowEnd).sort(order);
  const stale = mine.filter(t => daysSince(t.last_touched_at) >= STALE_DAYS && !due.includes(t)).sort(order);
  const closed = tasks.filter(t => t.closed_at && now - new Date(t.closed_at) < DAY && t.status === 'done');

  if (!open.length && !closed.length) return 'Nothing open. Nothing closed since yesterday.';
  const parts = [];

  const count = words(mine.length);
  const counts = [`${count[0].toUpperCase()}${count.slice(1)} open item${mine.length === 1 ? '' : 's'} on you`,
    `${waiting.length ? words(waiting.length) : 'nothing'} waiting on others`];
  if (delegated.length) counts.push(`${words(delegated.length)} with Kieran`);
  parts.push(`${list(counts)}.`);

  if (due.length) {
    const items = due.slice(0, 4).map(t => `${name(t)} is ${dueLabel(t, todayEnd)}`);
    if (due.length > 4) items.push(`${words(due.length - 4)} more come due by tomorrow`);
    parts.push(`${capitalize(list(items))}.`);
  } else {
    parts.push('Nothing due today or tomorrow.');
  }

  if (stale.length) {
    const items = stale.slice(0, 3).map(t => `${name(t)} has sat ${daysSince(t.last_touched_at)} days`);
    if (stale.length > 3) items.push(`${words(stale.length - 3)} more have gone quiet`);
    parts.push(`${capitalize(list(items))}.`);
  }

  const staleWaiting = waiting.filter(t => daysSince(t.last_touched_at) >= STALE_DAYS).sort(order);
  if (staleWaiting.length) {
    const t = staleWaiting[0];
    parts.push(`Longest wait is ${name(t)} at ${daysSince(t.last_touched_at)} days, worth a nudge.`);
  }

  if (delegated.length) {
    const items = delegated.sort(order).slice(0, 4).map(t => {
      const d = daysSince(t.last_touched_at);
      const notes = [t.due_at && new Date(t.due_at) <= tomorrowEnd && dueLabel(t, todayEnd),
        d >= STALE_DAYS && `quiet ${d} days`].filter(Boolean);
      return name(t, notes);
    });
    if (delegated.length > 4) items.push(`${words(delegated.length - 4)} more`);
    parts.push(`Kieran has ${list(items)}.`);
  }

  parts.push(closed.length
    ? `Since yesterday you closed ${list(closed.map(t => lowerFirst(t.title, t.person)))}.`
    : 'Nothing closed since yesterday.');

  const next = [...mine].sort(order)[0];
  if (next) parts.push(`Start with ${name(next)}.`);

  return parts.join(' ');
}

// Open items on Dror himself (not waiting, not with Kieran). The sweep's email subject.
function oweCount(tasks = store.board()) {
  return tasks.filter(isMine).length;
}

module.exports = { composeBrief, oweCount, STALE_DAYS };
