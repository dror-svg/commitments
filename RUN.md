# Running the dashboard on a Mac

You'll do this once. It takes about 15 minutes. Every step happens in **Terminal**. To open it, press ⌘ Space, type `Terminal`, and press Return. Then paste each command below and press Return.

## 1. Install the tools

First install Homebrew, the Mac's standard installer for developer tools. It asks for your Mac password, and nothing shows on screen while you type it. That's normal.

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

When it finishes, it prints two or three lines under **Next steps**. Paste and run those too. They tell Terminal where Homebrew lives.

Then install Node (which runs the dashboard) and GitHub's command line tool:

```
brew install node gh
```

## 2. Sign in to GitHub and download the repo

```
gh auth login
```

Pick **GitHub.com**, then **HTTPS**, then **Yes** to authenticate Git, then **Login with a web browser**. It shows a code. Your browser opens, you paste the code, and you approve.

```
cd ~/Documents
gh repo clone dror-svg/commitments
cd commitments
npm install
```

## 3. Add your Claude key

Get an API key at console.anthropic.com, under **API Keys**. Then run this, with your key in place of `sk-ant-...`:

```
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

## 4. Start it

```
npm start
```

Open **http://localhost:4141** in your browser. Leave the Terminal window open while you use the dashboard. To stop it, click the Terminal window and press Control C. It saves and syncs before quitting.

## Every day after that

Open Terminal and run:

```
cd ~/Documents/commitments && npm start
```

Then open http://localhost:4141. The dashboard pulls the morning sweep's changes from GitHub on its own, and pushes your changes back about 30 seconds after you make them.

## If something looks wrong

* **"command not found: brew"**: you skipped the **Next steps** lines in step 1. Close Terminal, open a new window, and run them.
* **The header says "sync paused"**: run `git status` and send me what it prints. Your changes are safe.
* **The chat says the key isn't set**: check that `.env` exists by running `cat .env`. It should show one line starting with `ANTHROPIC_API_KEY=`. Then stop the dashboard and start it again.
* **"Save as draft in Gmail" is greyed out**: that's expected for now. Gmail drafts get set up later.
