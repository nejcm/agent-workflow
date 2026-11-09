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
PR for agent/<ID> exists ──► In Review + comment with the PR link
session ended, no PR     ──► one comment "session ended without a PR"
ticket done / closed     ──► kill window, git worktree remove
```

- **Ready** = GitHub: open + `agent-ready` + `host:<host>` labels. Linear: `Todo` state + the same two labels.
- The `host:<host>` label decides which machine takes a ticket, so a laptop and a VM never pick up the same one.
- At most `maxConcurrent` sessions per lane. Ticket text only ever goes into the prompt file, never into a shell command.

## Setup

### 1. Requirements

On `PATH`: `bun`, `git`, `gh` (logged in: `gh auth status`), `tmux`, and `claude` and/or `codex`. For sandboxed lanes, install nono:

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
for l in agent-ready in-progress in-review "host:$(hostname -s)"; do gh label create "$l" --repo owner/repo --force; done
```

**Linear:** create the labels `agent-ready` and `host:<host>` in the team, make sure it has `Todo`, `In Progress`, `In Review`, `Done` states (or set your names in the config), and export a personal API key:

```bash
export LINEAR_API_KEY=lin_api_...
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

Then label one test issue `agent-ready` + `host:<host>` and run a single real pass:

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

Or as a systemd user service (edit `WorkingDirectory` and `PATH` in the unit first; put `LINEAR_API_KEY=…` in `~/.config/aw/env`):

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
| GitHub: `readyLabel`, `inProgressLabel`, `inReviewLabel` | `agent-ready`, `in-progress`, `in-review` | done = issue closed |
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

- **Unverified:** nono's GitHub credential route for `git push`; whether `gh`'s endpoint rules are wide enough; Remote Control endpoints beyond `claude.ai` from inside the sandbox; Linear `issue(id: "ENG-42")` lookup and filter shape; whether trusting `~/agent-ws` covers worktrees below it.
- **Main clone is agent-writable:** the sandbox grants `<repoPath>/.git` (worktree commits need it), so an agent could plant `.git/hooks` that later run outside the sandbox. Use a dedicated clone per lane.
- **Token scope:** the GitHub credential comes from `gh auth token` (all your scopes). Prefer a fine-grained token limited to the lane repos.
- **Codex under nono runs with `--no-daemon`** (required on Linux), so sandboxed Codex sessions show in the app history but can't be live-steered; with `sandbox: "none"` they can.
- **Safety rests on the sandbox:** agents run with `bypassPermissions` / `--ask-for-approval never`.
- A launch that fails after claiming leaves the ticket in progress with a "session ended" comment; PR review comments are not fed back into the session yet.
