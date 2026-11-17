# Setup

Install, configure and run `tender`. Agent logins are in [auth.md](auth.md); how sessions are isolated is in [sandbox.md](sandbox.md).

## Quick start

```bash
scripts/setup.sh owner/repo   # config dirs, nono, labels, .env and tender.json from the examples, login check
scripts/run.sh                # preflight (dry run), then poll in the foreground
```

To set up each repo, run the `tender-setup` skill in it. The skill writes `.tender/config.yaml`, runs `bun tender.ts check`, and prints the `tender.json` `repos` entry for you to add. Later, the `tender-maintain` skill proposes fixes for what the [contract check](intake.md#contract) reports, and intake rules the repo now qualifies for. To install both, run this from the tender clone. For Claude Code: `mkdir -p ~/.claude/skills && for s in tender-setup tender-maintain; do ln -s "$PWD/skills/$s" ~/.claude/skills/$s; done`. For Codex: the same with `~/.agents/skills`.

The same are available as `bun run setup owner/repo`, `bun run start`, `bun run once`, `bun run service`, `bun run status`, `bun run watch`, `bun run dry`, `bun run test` and `bun run typecheck` (`tsc --noEmit`; run `bun install` once for `@opentui/core`, the `watch` dashboard's only runtime dependency, and the dev-only `typescript` and `bun-types`; if it cannot be loaded `watch` falls back to plain output, and nothing else needs it). Edit `repos` and `sources` in `tender.json` before running, and add a [`.tender/config.yaml`](config.md#repo-config) to each repo (optional; `bun tender.ts check <repo>` validates it). `scripts/run.sh once` does a single pass; `scripts/run.sh service` installs and starts the systemd user unit. `run` and `once` hold a kernel lock on `<workspaceRoot>/.lock` while they live, so a second one on the same workspace exits with an error (`--dry-run`, `status`, `watch` and `tail` take no lock). The agent logins below are interactive; `scripts/setup.sh` prints what is still missing.

## 1. Requirements

Linux. On `PATH`: `bun`, `git`, `gh` (logged in: `gh auth status`), `tmux`, GNU `timeout` (coreutils; bounds every command `tender` runs), a systemd user manager (`systemd-run --user`, `systemctl --user`; each session runs in its own scope), `pgrep` (procps), and `claude` and/or `codex`. A skill named in `planStep` must be installed globally in `~/.claude/skills` (`scripts/setup.sh` links that dir into both agent config dirs). For sandboxed repos, install nono:

```bash
curl -fsSL https://nono.sh/install.sh | sh
```

## 2. Agent config dirs and logins

```bash
scripts/setup.sh owner/repo
```

Idempotent, never overwrites real files. It creates `~/.claude-tender` and `~/.codex-tender` (symlinking your `CLAUDE.md`, `AGENTS.md`, skills), creates `~/agent-ws` and `~/agent-repos`, and creates the labels for each repo you pass. Then check the logins.

## 3. Tracker

**GitHub:** create the labels in each repo (`scripts/setup.sh` prints these with your host name):

```bash
for l in agent in-progress in-review ready-to-merge needs-human "host:$(hostname -s)"; do gh label create "$l" --repo owner/repo --force; done
```

**Linear:** create the labels `agent`, `needs-human` and `host:<host>` in the team (`needs-human` may be a workspace label; `tender` does not create it and parking fails with an error naming it when it is missing), make sure it has `Todo`, `In Progress`, `In Review`, `Done` states (or set your names in the config) and, for [Ready to merge](lifecycle.md#ready-to-merge), a state named in `readyToMerge`, and put a personal API key in `.env` (gitignored, loaded by Bun from the working directory):

```bash
cp .env.example .env
```

A Linear ticket names its GitHub repo with a label `repo:owner/name` or a line `repo: owner/name` in its description; otherwise its project picks the repo whose `.tender/config.yaml` has `tracker: { linear: { project: "<name>" } }`. With none, it is skipped with one comment (see [Which repo a ticket goes to](lifecycle.md#which-repo-a-ticket-goes-to)).

## 4. Config

```bash
cp tender.example.json tender.json
```

Set `host` to the name in your `host:` label, list every repo `tender` may work on under `repos` (a plain `"owner/name"` takes the `defaults`; `{ "name": "owner/name", … }` overrides them), and add one source per GitHub label set / Linear team. `tender.json` is gitignored. See [Config reference](config.md#config-reference).

## 5. First run

Dry run — logs every side effect instead of doing it:

```bash
bun tender.ts once --dry-run
```

Then label one test issue `agent` + `host:<host>` and run a single real pass:

```bash
bun tender.ts once
```

```bash
tmux attach -t tender
```

Go through the [first-run checklist](#first-run-checklist) before pointing it at real tickets.

## 6. Run continuously

Foreground:

```bash
bun tender.ts run
```

Or as a systemd user service (edit `WorkingDirectory` (it points at `~/Work/agent-workflow`) and `PATH` in the unit first; the unit's `WorkingDirectory` holds the `.env`):

```bash
cp systemd/tender.service ~/.config/systemd/user/ && systemctl --user enable --now tender
```

For the weekly [PR sweep](prs.md), `scripts/run.sh prs-service` installs and starts `tender-prs.timer` (on one host only).

`KillMode=process` keeps agent sessions alive when the service restarts. `bun tender.ts status` lists sources, repos (with their `autoMerge` and `maxInReview`), a line when a `maxInReview` is reached, and one row per worktree; see [Watching sessions](watching.md#watching-sessions).

## GitHub identity (optional)

By default `tender` acts as your `gh` login: it claims tickets, comments and merges as you, and sessions push and open PRs as you, so you cannot approve their PRs. Two alternatives:

| | GitHub App | Machine user |
|---|---|---|
| PRs and comments by | `<app-slug>[bot]`, so you can approve them | the second account, so you can approve them |
| Token | installation token minted per hour, limited to the allowlisted repos and the permissions below | a fine-grained token you create and rotate |
| Claim | label and comment only: an App cannot be an assignee | unchanged, assigns the machine user |
| Sandbox | every repo `nono` | any |
| Cost | a free App; one owner per host config | a second GitHub seat on a paid org plan |

### GitHub App

1. Create an App (your account or org, **Settings → Developer settings → GitHub Apps → New**): no webhook, no callback URL, installable only on this account. Repository permissions:
   - **Contents: Read and write:** clone, sessions push `agent/<ID>`, `gh pr merge`, deleting merged and orphan branches.
   - **Pull requests: Read and write:** sessions' `gh pr create`, PR views, reviews and comments for feedback, `gh pr close` in the sweep.
   - **Issues: Read and write:** labels, comments, sub-issues, filing findings and intake tickets, close and reopen.
   - **Checks: Read** and **Commit statuses: Read:** `statusCheckRollup` for feedback, Ready to merge and the sweep.
   - **Actions: Read:** failed CI logs for feedback (`gh run view --log-failed`).
   - **Metadata: Read** (required).

   Leave **Workflows** off: a session commit that touches `.github/workflows/` is then refused at push.
2. **Generate a private key** and store it outside the repo, readable only by you: `install -m 600 ~/Downloads/<app>.*.private-key.pem ~/.config/tender/github-app.pem`. GitHub's `BEGIN RSA PRIVATE KEY` (PKCS#1) file is read as is.
3. **Install** the App on the repos in `repos` (all must have one owner). The installation ID is the number at the end of the installation's settings URL (`…/settings/installations/<id>`); the App ID is on the App's page.
4. Add to `tender.json`:

   ```json
   "githubApp": { "appId": 123456, "installationId": 7890123, "privateKeyFile": "~/.config/tender/github-app.pem" }
   ```

5. `scripts/run.sh` (its dry run mints a token) or `bun tender.ts once --dry-run`. A wrong ID or key fails here with GitHub's answer.

`gh` itself stays logged in as you: `tender` passes the App token only to its own `gh` calls and an invalid `GH_TOKEN=tender-app-required` to every other command it runs, so a `gh` call it missed fails instead of acting as you. Host `git` (`fetch`, the session clone) is the exception and still uses your git credentials (read-only use). Switch with nothing In Progress or In Review, or remove yourself as assignee first: with the App any assignee is someone else, so such tickets would be stopped as reassigned. Token handling is in [Sandbox](sandbox.md) (GitHub credentials).

### Machine user

Create a second GitHub account, add it as a collaborator (Write) on each repo, and log `gh` in as it on the host (`gh auth login`, or `GH_TOKEN` in the service environment) with a fine-grained token limited to the allowlisted repos and the same permissions as the App above. Nothing in `tender.json` changes; the claim assigns the machine user, and `feedbackAuthors` stays your own login.

## Linear identity (optional)

By default `tender` acts on Linear as the owner of `LINEAR_API_KEY`: the claim assigns the ticket to you. As a Linear OAuth app it acts as the app instead: comments, moves and filed tickets are by the app, and the claim sets the ticket's **delegate** to the app and leaves its assignee alone, so a human keeps owning it ([Linear: agents](https://linear.app/developers/agents)).

### Linear app

1. Create an OAuth app (**Settings → API → OAuth applications → New**, workspace admin): no webhooks, any callback URL (unused). Turn on **Client credentials**.
2. Put its client secret in `.env` as `LINEAR_CLIENT_SECRET` (like `LINEAR_API_KEY`, never in `tender.json`; sessions and `tender open --exec` never see it).
3. Add to `tender.json`:

   ```json
   "linearApp": { "clientId": "<client ID>" }
   ```

4. `scripts/run.sh` (its dry run mints a token) or `bun tender.ts once --dry-run`.

No browser install is needed: `tender` mints [client-credentials tokens](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens) (`actor=app` always, 30 days, no refresh token) with the scopes `read,write,app:assignable`, keeps one in memory per process, mints a new one a day before expiry or after a 401, and never falls back to `LINEAR_API_KEY`. `run` and `once` exit if the first mint fails. Such a token reaches all public teams in the workspace; a private team must add the app. Keep the scopes fixed: Linear replaces the app's tokens when a request asks for different ones, and rotating the client secret revokes them. A client-credentials request also replaces an app installation made through the browser (`actor=app`) flow.

The app shows in Linear's agent UI only as the delegate: tender posts no agent session activity. Linear opens a session on delegation; answering it without webhooks would mean finding and tracking that session across polls, which tender does not do yet, so it may show as unresponsive. Switching is safe with tickets In Progress: they are assigned to you and have no delegate, which counts as tender's. A ticket delegated to another agent is someone else's.

## On a VM

Same steps on the VM (Tailscale for access), with `"sandbox": "none"` in `defaults` (or per repo) and `"host": "vm"` in `tender.json`. Tickets labelled `host:vm` go there. Connect your editor with Remote-SSH to `~/agent-ws/<owner>/<name>/<ID>`.

## First-run checklist

Prove the sandbox boundaries on a throwaway repo first.

- [ ] Inside a sandboxed session, `cat ~/.ssh/id_*`, `ls ~/Work/<other-repo>`, `ls ~/.config` fail.
- [ ] Writing `~/.claude/CLAUDE.md`, `~/.claude/settings.json` or anything in `~/.claude-tender` fails, and so does reading `~/.claude/.credentials.json`; your CLAUDE.md, AGENTS.md and skills load.
- [ ] `env | grep -iE 'token|key'` shows only phantom values; `LINEAR_API_KEY` and `LINEAR_CLIENT_SECRET` are absent.
- [ ] `git push -u origin agent/<ID>` and `gh pr create` work, also with an SSH `origin`.
- [ ] Sandboxed Codex reaches its backend (`chatgpt.com`, `auth.openai.com`).
- [ ] Codex session is in the app history.
- [ ] Inside a sandboxed session, `tmux -S /tmp/tmux-$(id -u)/default list-sessions` fails with `Permission denied`.
- [ ] Inside a sandboxed session, `mktemp` prints a path under `<ID>.tmpdir` and `touch /tmp/x` fails.
- [ ] Inside a sandboxed session, writing anything under `~/agent-repos` (the base clone's objects, refs, config included) or another session's clone fails; commit, fetch, rebase, `push -u` and `gh pr create` still work.
- [ ] A Linear ticket for a repo not in `repos` gets one comment and no worktree, also after restarting `tender`.
- [ ] Issue → PR → `in-review`; closing the issue removes the window and the session clone.
