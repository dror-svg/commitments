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

function name(t) {
  const first = t.person?.split(' ')[0];
  const named = first && t.title.toLowerCase().includes(first.toLowerCase());
  const who = t.person && !named ? ` ${t.direction === 'they_owe' ? 'from' : 'for'} ${t.person}` : '';
  const lp = t.person_relationship === 'lp' ? ' (LP)' : '';
  return `${t.title}${who}${lp}`;
}

function dueLabel(t, todayEnd) {
  const due = new Date(t.due_at);
  if (due < Date.now()) {
    const d = daysSince(t.due_at);
    return d === 0 ? 'due earlier today' : `${d} day${d === 1 ? '' : 's'} overdue`;
  }
  return due <= todayEnd ? 'due today' : 'due tomorrow';
}

function composeBrief(tasks = store.board(), now = new Date()) {
  const open = tasks.filter(t => store.OPEN_STATUSES.includes(t.status));
  const mine = open.filter(t => t.direction === 'i_owe' && t.status !== 'waiting');
  const waiting = open.filter(t => t.status === 'waiting' || t.direction === 'they_owe');
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const tomorrowEnd = new Date(todayEnd.getTime() + DAY);
  const byPriority = (a, b) => rank(a) - rank(b) || new Date(a.last_touched_at) - new Date(b.last_touched_at);

  const due = open.filter(t => t.due_at && new Date(t.due_at) <= tomorrowEnd)
    .sort((a, b) => rank(a) - rank(b) || new Date(a.due_at) - new Date(b.due_at));
  const stale = mine.filter(t => daysSince(t.last_touched_at) >= STALE_DAYS && !due.includes(t)).sort(byPriority);
  const closed = tasks.filter(t => t.closed_at && now - new Date(t.closed_at) < DAY && t.status === 'done');

  const parts = [];
  if (!open.length && !closed.length) return 'Nothing open. Nothing closed since yesterday.';

  parts.push(`${words(mine.length)[0].toUpperCase()}${words(mine.length).slice(1)} open item${mine.length === 1 ? '' : 's'} on you, ${waiting.length ? words(waiting.length) : 'nothing'} waiting on others.`);

  if (due.length) {
    const items = due.slice(0, 4).map(t => `${name(t)} is ${dueLabel(t, todayEnd)}`);
    if (due.length > 4) items.push(`${words(due.length - 4)} more come due by tomorrow`);
    parts.push(`${list(items)}.`);
  } else {
    parts.push('Nothing due today or tomorrow.');
  }

  if (stale.length) {
    const items = stale.slice(0, 3).map(t => `${name(t)} has sat ${daysSince(t.last_touched_at)} days`);
    if (stale.length > 3) items.push(`${words(stale.length - 3)} more have gone quiet`);
    parts.push(`${list(items)}.`);
  }

  const staleWaiting = waiting.filter(t => daysSince(t.last_touched_at) >= STALE_DAYS).sort(byPriority);
  if (staleWaiting.length) {
    const t = staleWaiting[0];
    parts.push(`Longest wait is ${name(t)} at ${daysSince(t.last_touched_at)} days, worth a nudge.`);
  }

  parts.push(closed.length
    ? `Since yesterday you closed ${list(closed.map(t => t.title))}.`
    : 'Nothing closed since yesterday.');

  const next = [...due.filter(t => t.direction === 'i_owe'), ...stale, ...mine.sort(byPriority)][0];
  if (next) parts.push(`Start with ${name(next)}.`);

  return parts.join(' ');
}

// Open items on Dror that aren't parked waiting on someone else. The sweep's email subject.
function oweCount(tasks = store.board()) {
  return tasks.filter(t => store.OPEN_STATUSES.includes(t.status) && t.direction === 'i_owe' && t.status !== 'waiting').length;
}

module.exports = { composeBrief, oweCount, STALE_DAYS };
