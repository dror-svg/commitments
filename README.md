# commitments

Personal follow-through system. SQLite store in `data/commitments.db` (committed), raw capture in `inbox.md`.

```
npm install
node cli.js add "Send Q3 deck to Maya" --person "Maya Chen" --email maya@example.com --source email --ref <thread-id> --excerpt "I'll send the deck Friday." --due +3d
node cli.js list            # open: new, active, waiting
node cli.js done 1 "sent"
node cli.js log 1
node cli.js --help          # everything else (status, snooze, note, update, find, person, people)
```

Add `--json` to any command for machine-readable output. `COMMITMENTS_DB=/path/to.db` points at a different database.
