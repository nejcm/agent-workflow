# aw — agent workflow

Move a GitHub issue or Linear ticket to **ready**, and `aw` starts a Claude Code or Codex session for it: in its own git worktree, inside the [nono](https://github.com/nolabs-ai/nono) sandbox, in a tmux window you can attach to. The agent implements the ticket, runs the tests, pushes `agent/<ID>` and opens a PR; `aw` then moves the ticket to **In Review**.

- **Watch and steer from anywhere.** Claude sessions run with Remote Control, so they show up on claude.ai/code and the Claude mobile app. Codex sessions are interactive, so they land in the ChatGPT/Codex app history. Locally: `tmux attach -t aw`, or open the worktree in your editor.
- **Runs where you are.** Directly on your machine (sandboxed by nono), or on a VM (`sandbox: "none"`, the VM is the boundary). Same code, same config.
- **No moving parts to babysit.** One Bun + TypeScript file, no dependencies, no database: state is the tracker, the tmux windows and the worktrees. Polls instead of webhooks, so nothing listens on a port.
- **Your setup, read-only.** Agents use your `CLAUDE.md`, `AGENTS.md` and skills, but log in through their own config dirs (`~/.claude-aw`, `~/.codex-aw`) and cannot modify yours.

## How it works

Every `pollIntervalMs` (default 60 s), for each *lane* (one repo or Linear team) in `aw.json`:

```
ready ticket ──► In Progress + comment "picked up on <host>"
             ──► git worktree add ~/agent-ws/<lane>/<ID> -b agent/<ID> origin/<base>
             ──► tmux window <lane>/<ID>: nono run … -- claude --remote-control … "<prompt>"
.aw/phases.json changed  ──► create / update phase sub-tickets
PR for agent/<ID> exists ──► In Review + comment with the PR link
session ended, no PR     ──► one comment "session ended without a PR"
ticket done / closed     ──► kill window, git worktree remove
```

- **Ready** = GitHub: open + `agent` + `host:<host>` labels. Linear: `Todo` state + the same two labels.
- The `host:<host>` label decides which machine takes a ticket, so a laptop and a VM never pick up the same one. With `"defaultHost": true` this machine also takes tickets with no `host:` label at all, so on a single laptop you only need `agent`. Set it on one machine only: claiming is not atomic, so two default hosts can both start the same unlabelled ticket.
- The `agent` label is never removed, as a permanent record. On GitHub a ticket is skipped while it has `in-progress` or `in-review`; to re-run one, close its old PR and remove that label.
- At most `maxConcurrent` sessions per lane. Ticket text only ever goes into the prompt file, never into a shell command.

### Phases

The default prompt has the agent plan with the `agent-orchestration` skill. When it splits the work into phases it writes them to `.aw/phases.json` in its worktree (git-ignored via `.aw/.gitignore`): an array of `{ key, title, body, status }`, status `todo` → `in-progress` → `done`. The agent never talks to the tracker; on every poll, for each of its in-progress and in-review tickets, `aw` mirrors the file:

- a new `key` → a sub-ticket of the parent titled `<ID>: <title>`, with no labels (GitHub: `gh issue create --parent`; Linear: child issue in `Todo`, same team);
- `in-progress` → the `in-progress` label / `In Progress` state;
- `done` → shown as in-progress while the parent is In Progress; closed / first `done` state once the PR exists, just before the parent moves to In Review. Closing children mid-session could trip Linear's team setting "auto-close parent when all sub-issues are done" and `aw` would then clean up the running session.

Phases are history, not a gate: the same session works the ticket to the PR, and the parent's lifecycle is unchanged. Sub-tickets lack the `agent` label, so they are never picked up as work, `defaultHost` included. Created refs and synced statuses live in `<workspaceRoot>/<lane>/<ID>.phases.json`, outside the sandbox, written atomically. Before creating a sub-ticket `aw` lists the parent's existing ones and adopts one with the same `<ID>: <title>` that it has no record of, so a crash or lost response between creating and recording doesn't duplicate it. Tickets in review keep syncing every poll, so a failed final sync is retried. The file is untrusted: max 64 KiB and 20 phases, `key` `[a-z0-9-]{1,40}` starting with a letter or digit, one-line title ≤ 120, body ≤ 4000; `.aw` and the file are opened without following symlinks (the directory is pinned by fd via `/proc`, so Linux only) and anything but a regular file is rejected. An invalid file is logged and skipped for that poll, and a status moving back is ignored. Cleanup leaves sub-tickets as they are.

## Quick start

```bash
./setup.sh owner/repo   # config dirs, nono, labels, .env and aw.json from the examples, login check
./run.sh                # preflight (dry run), then poll in the foreground
```

Edit `aw.json` lanes before running. `./run.sh once` does a single pass; `./run.sh service` installs and starts the systemd user unit. The agent logins and the workspace trust dialog below are interactive; `setup.sh` prints what is still missing.

## Setup

### 1. Requirements

On `PATH`: `bun`, `git`, `gh` (logged in: `gh auth status`), `tmux`, and `claude` and/or `codex`. The default prompt needs the `agent-orchestration` skill installed globally in `~/.claude/skills` (`setup.sh` links that dir into both agent config dirs). For sandboxed lanes, install nono:

```bash
curl -fsSL https://nono.sh/install.sh | sh
```

### 2. Agent config dirs and logins

```bash
./setup.sh owner/repo
```

Idempotent, never overwrites real files. It creates `~/.claude-aw` and `~/.codex-aw` (symlinking your `CLAUDE.md`, `AGENTS.md`, skills), creates `~/agent-ws`, and prints the label commands for each repo you pass. Then log the agents in — these are separate from your own sessions:

```bash
CLAUDE_CONFIG_DIR=~/.claude-aw claude
```

Run `/login` inside, then exit.

```bash
CODEX_HOME=~/.codex-aw codex login
```

Trust the workspace once, so Remote Control can start there (accept the dialog, then exit):

```bash
cd ~/agent-ws && CLAUDE_CONFIG_DIR=~/.claude-aw claude
```

Check the sandbox profiles parse:

```bash
nono profile validate nono/aw-claude.json
```

```bash
nono profile validate nono/aw-codex.json
```

### 3. Tracker

**GitHub:** create the labels in each repo (`setup.sh` prints these with your host name):

```bash
for l in agent in-progress in-review "host:$(hostname -s)"; do gh label create "$l" --repo owner/repo --force; done
```

**Linear:** create the labels `agent` and `host:<host>` in the team, make sure it has `Todo`, `In Progress`, `In Review`, `Done` states (or set your names in the config), and put a personal API key in `.env` (gitignored, loaded by Bun from the working directory):

```bash
cp .env.example .env
```

### 4. Config

```bash
cp aw.example.json aw.json
```

Set `host` to the name in your `host:` label and one lane per repo / Linear team. `aw.json` is gitignored. See [Config reference](#config-reference).

### 5. First run

Dry run — logs every side effect instead of doing it:

```bash
bun aw.ts once --dry-run
```

Then label one test issue `agent` + `host:<host>` and run a single real pass:

```bash
bun aw.ts once
```

```bash
tmux attach -t aw
```

Go through the [first-run checklist](#first-run-checklist) before pointing it at real tickets.

### 6. Run continuously

Foreground:

```bash
bun aw.ts run
```

Or as a systemd user service (edit `WorkingDirectory` and `PATH` in the unit first; the unit's `WorkingDirectory` holds the `.env`):

```bash
cp systemd/aw.service ~/.config/systemd/user/ && systemctl --user enable --now aw
```

`KillMode=process` keeps agent sessions alive when the service restarts. `bun aw.ts status` lists lanes, running windows and worktrees.

### On a VM

Same steps on the VM (Tailscale for access), with `"sandbox": "none"` per lane and `"host": "vm"` in `aw.json`. Tickets labelled `host:vm` go there. Connect your editor with Remote-SSH to `~/agent-ws/<lane>/<ID>`.

## Config reference

| key | default | |
|---|---|---|
| `host` | required | matches the `host:<host>` label |
| `defaultHost` | `false` | also take tickets with no `host:` label (not other hosts') |
| `pollIntervalMs` | `60000` | min 5000 |
| `workspaceRoot` | `~/agent-ws` | worktrees, prompts, launchers |
| `tmuxSession` | `aw` | |
| `lanes[].name` | required | `[a-z0-9-]`, unique |
| `lanes[].tracker` | required | `github` \| `linear` |
| `lanes[].repo` | required | GitHub `owner/name` the PRs go to |
| `lanes[].repoPath` | required | local clone |
| `lanes[].baseBranch` | `main` | |
| `lanes[].agent` | required | `claude` \| `codex` |
| `lanes[].sandbox` | required | `nono` \| `none` |
| `lanes[].maxConcurrent` | `2` | sessions per lane |
| `lanes[].testCmd` | required | the agent must pass it before opening a PR |
| `lanes[].prompt` | `prompts/default.md` | template, relative to the config file |
| GitHub: `readyLabel`, `inProgressLabel`, `inReviewLabel` | `agent`, `in-progress`, `in-review` | done = issue closed |
| Linear: `team`, `todo`, `inProgress`, `inReview`, `done` | —, `Todo`, `In Progress`, `In Review`, `[Done, Canceled, Duplicate]` | `team` is the key, e.g. `ENG` |

Prompt placeholders: `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{testCmd}} {{repo}}`.

CLI: `bun aw.ts <run|once|status> [--dry-run] [--config aw.json]`.

## First-run checklist

The nono profiles have not been run yet; prove the boundaries on a throwaway repo first.

- [ ] Inside a sandboxed session, `cat ~/.ssh/id_*`, `ls ~/Work/<other-repo>`, `ls ~/.config` fail.
- [ ] Writing `~/.claude/CLAUDE.md` or `~/.claude/settings.json` fails; your CLAUDE.md, AGENTS.md and skills load.
- [ ] `env | grep -iE 'token|key'` shows only phantom values; `LINEAR_API_KEY` is absent.
- [ ] `git push -u origin agent/<ID>` and `gh pr create` work, also with an SSH `origin`.
- [ ] Sandboxed Codex reaches its backend (`chatgpt.com`, `auth.openai.com`).
- [ ] Claude session is visible and steerable on claude.ai/code / mobile; Codex session is in the app history.
- [ ] Issue → PR → `in-review`; closing the issue removes the window and the worktree.

## Known gaps

- **Unverified:** nono's GitHub credential route for `git push`; whether `gh`'s endpoint rules are wide enough; Remote Control endpoints beyond `claude.ai` from inside the sandbox; Linear `issue(id: "ENG-42")` lookup and filter shape; whether trusting `~/agent-ws` covers worktrees below it; phase sub-tickets against live services (`gh issue create --parent`, `gh api …/sub_issues`, Linear `children`, Linear `issueCreate` with `parentId`, and that Linear adds no default labels to child issues); Codex picking up skills from `~/.codex-aw/skills`.
- **Phase side effects:** with Linear's "auto-close parent when all sub-issues are done", the parent can still close when the PR opens (the final sync closes the children); `aw` then moves it to In Review, but if Linear applies the auto-close later the parent ends Done and `aw` cleans up the finished session. Turn that setting off for `aw` teams. Adopting an orphaned sub-ticket matches on title, so two phases with the same title can share one sub-ticket after a crash. On GitHub the sandboxed agent still has `gh` access, so "never touches the tracker" is a prompt rule there, not a boundary.
- **Main clone is agent-writable:** the sandbox grants `<repoPath>/.git` (worktree commits need it), so an agent could plant `.git/hooks` that later run outside the sandbox. Use a dedicated clone per lane.
- **Token scope:** the GitHub credential comes from `gh auth token` (all your scopes). Prefer a fine-grained token limited to the lane repos.
- **Codex under nono runs with `--no-daemon`** (required on Linux), so sandboxed Codex sessions show in the app history but can't be live-steered; with `sandbox: "none"` they can.
- **Claude sessions can run Codex:** the Claude profile also grants `~/.codex-aw`, `CODEX_HOME`, `chatgpt.com` and `auth.openai.com`, so `agent-orchestration` can delegate to Codex. This widens the sandbox: a session can read the agent's Codex login (a long-lived ChatGPT refresh token) and rewrite `~/.codex-aw/config.toml`, so a prompt-injected Claude session can plant code that later Codex lanes run. Claude and Codex lanes now share one trust domain. Remove those entries if you don't want it.
- **Safety rests on the sandbox:** agents run with `bypassPermissions` / `--ask-for-approval never`.
- **List limit with `defaultHost`:** each poll fetches at most 100 tickets per query. With `defaultHost` the host filter is applied client-side (no query can express "no `host:` label"), so more than 100 ready tickets for other hosts can hide unlabelled ones.
- A launch that fails after claiming leaves the ticket in progress with a "session ended" comment; PR review comments are not fed back into the session yet.
