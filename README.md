# commitments

Personal follow-through system. SQLite store in `data/commitments.db` (committed), raw capture in `inbox.md`, style guide in `CLAUDE.md`.

Not a developer? Start with [RUN.md](RUN.md).

## Setup

```
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY
node scripts/google-auth.js # optional: Gmail drafts (needs GOOGLE_CLIENT_ID/SECRET in .env first)
npm start                   # http://localhost:4141
```

Gmail needs a Google Cloud OAuth client of type "Desktop app" with the Gmail API enabled. Scopes are `gmail.compose` (create drafts) and `gmail.readonly` (read thread headers so a draft lands as a reply in the right thread). Nothing in this repo can send mail.

## Dashboard

Four columns (New, Active, Waiting on them, Done for the last 14 days), each sorted stalest first. A card untouched for 5+ days gets an amber edge and an "Nd untouched" tag. The brief at the top is regenerated on every load.

Click a card for the side panel with the source excerpt and link, the log, status buttons, and a chat with Claude scoped to that task. The system prompt is `CLAUDE.md` plus the task row, the log, and the excerpt. Both sides of the chat are written to `task_log` as `kind=chat` (your turns are prefixed `Dror: `). When a reply contains a draft, it is also logged as `kind=draft` and gets a "Save as draft in Gmail" button. For email tasks the draft is threaded onto `source_ref`.

The inbox strip saves as you type. "Process inbox" turns each line into a task in New. Lines starting with `?` (the sweep's guesses) and `#` stay put.

## Sync

The DB is a binary file, so git can't merge it. Every write through `db.js` is also appended to `data/commitments.db.pending.jsonl` (gitignored). `sync` fetches, and if the remote moved, takes the remote DB, replays the journal on top (renumbering tasks created locally), merges `inbox.md` line by line, commits the data files, and pushes. The journal clears once the push lands.

The dashboard pulls on start and on page load (at most every 5 minutes), and pushes 30 seconds after the last change. It syncs whatever branch is checked out. `SYNC=off` in `.env` turns it off. If sync pauses (a merge conflict outside the data files), the header says so and nothing is lost.

## Sweep

`sweep.md` is the prompt for the daily cloud scheduled task (6am PT, with Gmail, Google Calendar, Granola, Slack, and GitHub connected). Paste it as the task prompt. It processes `inbox.md`, extracts explicit commitments from the window since `data/last_sweep.txt`, closes tasks with clear evidence, writes `data/brief.md`, syncs to `main`, and emails the brief to Dror. It sends no other mail and changes nothing outside the repo. Uncertain finds go to `inbox.md` with a `?` prefix.

The cloud environment needs Node and network access to npm and GitHub (`npm ci` downloads the prebuilt SQLite binary from GitHub releases).

## CLI

```
node cli.js add "Send Q3 deck to Maya" --person "Maya Chen" --email maya@example.com --source email --ref <thread-id> --excerpt "I'll send the deck Friday." --due +3d
node cli.js list            # open: new, active, waiting
node cli.js done 1 "sent"
node cli.js log 1
node cli.js brief
node cli.js process-inbox
node cli.js sync
node cli.js --help          # everything else
```

Add `--json` to any command for machine-readable output. `COMMITMENTS_DB=/path/to.db` points at a different database.
