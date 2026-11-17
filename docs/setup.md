# Setup

Install, configure and run `tender`. Agent logins are in [auth.md](auth.md); how sessions are isolated is in [sandbox.md](sandbox.md).

## Quick start

```bash
scripts/setup.sh owner/repo   # config dirs, nono, labels, .env and tender.json from the examples, login check
scripts/run.sh                # preflight (dry run), then poll in the foreground
```

To set up each repo, run the `tender-setup` skill in it. The skill writes `.tender/config.yaml`, runs `bun tender.ts check`, and prints the `tender.json` `repos` entry for you to add. Later, the `tender-maintain` skill proposes fixes for what the [contract check](intake.md#contract) reports, and intake rules the repo now qualifies for. Both live in this repo's `.agents/skills/` (Codex) with `.claude/skills/` symlinks (Claude Code), so a session in the tender clone has them. To use them in another repo, run there `npx skills add nejcm/agent-workflow --skill tender-setup tender-maintain` ([skills.sh](https://skills.sh)).

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

## On a VM

Same steps on the VM (Tailscale for access), with `"sandbox": "none"` in `defaults` (or per repo) and `"host": "vm"` in `tender.json`. Tickets labelled `host:vm` go there. Connect your editor with Remote-SSH to `~/agent-ws/<owner>/<name>/<ID>`.

## First-run checklist

Prove the sandbox boundaries on a throwaway repo first.

- [ ] Inside a sandboxed session, `cat ~/.ssh/id_*`, `ls ~/Work/<other-repo>`, `ls ~/.config` fail.
- [ ] Writing `~/.claude/CLAUDE.md`, `~/.claude/settings.json` or anything in `~/.claude-tender` fails, and so does reading `~/.claude/.credentials.json`; your CLAUDE.md, AGENTS.md and skills load.
- [ ] `env | grep -iE 'token|key'` shows only phantom values; `LINEAR_API_KEY` is absent.
- [ ] `git push -u origin agent/<ID>` and `gh pr create` work, also with an SSH `origin`.
- [ ] Sandboxed Codex reaches its backend (`chatgpt.com`, `auth.openai.com`).
- [ ] Codex session is in the app history.
- [ ] Inside a sandboxed session, `tmux -S /tmp/tmux-$(id -u)/default list-sessions` fails with `Permission denied`.
- [ ] Inside a sandboxed session, `mktemp` prints a path under `<ID>.tmpdir` and `touch /tmp/x` fails.
- [ ] Inside a sandboxed session, writing anything under `~/agent-repos` (the base clone's objects, refs, config included) or another session's clone fails; commit, fetch, rebase, `push -u` and `gh pr create` still work.
- [ ] A Linear ticket for a repo not in `repos` gets one comment and no worktree, also after restarting `tender`.
- [ ] Issue → PR → `in-review`; closing the issue removes the window and the session clone.
