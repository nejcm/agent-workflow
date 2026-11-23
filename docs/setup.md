# Setup

Install, configure and run `tender`. Agent logins are in [auth.md](auth.md); how sessions are isolated is in [sandbox.md](sandbox.md).

## Quick start

```bash
bun install                   # @opentui/core for the watch dashboard, typescript and bun-types for typecheck
scripts/setup.sh owner/repo   # config dirs, labels, .env, tender.json for these repos, nono if a repo needs it, login check
scripts/run.sh                # preflight (dry run, stops on errors), then poll in the foreground
```

To set up each repo, run the `tender-setup` skill in it. The skill writes `.tender/config.yaml` and any type overrides, runs `bun tender.ts check`, prints the `tender.json` `repos` entry for you to add, and, if the repo has no verification skill and `create-verification` is installed, offers to hand off to it. Later, the `tender-maintain` skill proposes fixes for what the [contract check](intake.md#contract) reports, and intake rules the repo now qualifies for. Both live in this repo's `.agents/skills/` (Codex) with `.claude/skills/` symlinks (Claude Code), so a session in the tender clone has them. To use them in another repo, run there `npx skills add nejcm/agent-workflow --skill tender-setup tender-maintain` ([skills.sh](https://skills.sh)).

The same are available as `bun run setup owner/repo`, `bun run start`, `bun run once`, `bun run service`, `bun run status`, `bun run watch`, `bun run dry`, `bun run test` and `bun run typecheck` (`tsc --noEmit`). Without `bun install`, `watch` falls back to plain output and `typecheck` fails; nothing else needs it. Check `repos` and `sources` in `tender.json` before running, and add a [`.tender/config.yaml`](config.md#repo-config) to each repo (optional; `bun tender.ts check <repo>` validates it). `scripts/run.sh once` does a single pass; `scripts/run.sh service` installs and starts the systemd user unit, `scripts/run.sh intake-service` the [intake](intake.md) timer and `scripts/run.sh prs-service` the [PR sweep](prs.md) timer. `run` and `once` hold a kernel lock on `<workspaceRoot>/.lock` while they live, so a second one on the same workspace exits with an error (`--dry-run`, `status`, `watch` and `tail` take no lock). The agent logins below are interactive; `scripts/setup.sh` prints what is still missing.

## 1. Requirements

Linux, or macOS without the sandbox (see below). On `PATH`: `bun`, `git`, `gh` 2.94.0 or later (logged in: `gh auth status`; listing reads issue types, which need GitHub.com or GHES 3.17+), `tmux`, GNU `timeout` (coreutils; bounds every command `tender` runs), a systemd user manager (`systemd-run --user`, `systemctl --user`; each session runs in its own scope), `pgrep` (procps), and `claude` and/or `codex`. A skill named in a profile's instruction file must be committed in the repo (`.claude/skills/`, `.agents/skills/`) or installed globally in `~/.claude/skills` (`scripts/setup.sh` links that dir into both agent config dirs). For repos with `sandbox: "nono"` and on the intake host (intake scripts always run under nono), install nono (`scripts/setup.sh` does it when `tender.json` needs it):

**macOS (partial, untested on a Mac).** Use `sandbox: "none"` (`scripts/setup.sh --sandbox=none`); the nono profiles are Linux-only (Landlock), so the intake host must be Linux. Install `gtimeout` and `flock` (`brew install coreutils flock`) in place of `timeout`, and no systemd is needed: sessions run without a scope, so a canceled ticket kills its tmux window but not a `setsid`'d child, and answers reach a session by paste, never the inbox hook. `scripts/run.sh service|intake-service|prs-service` write launchd agents to `~/Library/LaunchAgents`. Known gaps: the fd-pinned reads of `.tender/` and transcripts use `/proc/self/fd`, so live state, hand-off and transcript reads do not work yet.

```bash
curl -fsSL https://nono.sh/install.sh | sh
```

## 2. Agent config dirs and logins

```bash
scripts/setup.sh owner/repo
```

Idempotent, never overwrites real files. It creates `~/.claude-tender` and `~/.codex-tender` (symlinking your `CLAUDE.md`, `AGENTS.md`, skills), creates `~/agent-ws` and `~/agent-repos`, writes `.env` and `tender.json` (see [Config](#4-config)), installs nono and validates its profiles when `tender.json` needs it, and creates the labels for each repo you pass. Then check the logins.

## 3. Tracker

**GitHub:** create the labels in each repo (`scripts/setup.sh` prints these with your host name):

```bash
for l in agent in-progress in-review ready-to-merge needs-human "host:$(hostname -s)"; do gh label create "$l" --repo owner/repo --force; done
```

**Linear:** create the labels `agent`, `needs-human` and `host:<host>` in the team (`needs-human` may be a workspace label; `tender` does not create it and parking fails with an error naming it when it is missing), make sure it has `Todo`, `In Progress`, `In Review`, `Done` states (or set your names in the config) and, for [Ready to merge](lifecycle.md#ready-to-merge), a state named in `readyToMerge`, and set `LINEAR_API_KEY` to a personal API key in `.env` (gitignored, loaded by Bun from the working directory; `scripts/setup.sh` writes it from `.env.example` with the key commented out).

A Linear ticket names its GitHub repo with a label `repo:owner/name` or a line `repo: owner/name` in its description; otherwise its project picks the repo whose `.tender/config.yaml` has `tracker: { linear: { project: "<name>" } }`. With none, it is skipped with one comment (see [Which repo a ticket goes to](lifecycle.md#which-repo-a-ticket-goes-to)).

## 4. Config

`scripts/setup.sh [--linear] [--sandbox=none] owner/repo …` writes `tender.json` from [`tender.example.json`](../tender.example.json) when it is missing: `host` is `hostname -s`, `repos` the repos you pass, `defaults.sandbox` `nono` (or `none`), and only the GitHub source unless `--linear` adds the example Linear one (fill in its `team` and states). Without repos it keeps the example's placeholders.

Check `host` is the name in your `host:` label, list every repo `tender` may work on under `repos` (a plain `"owner/name"` takes the `defaults`; `{ "name": "owner/name", … }` overrides them), and add one source per GitHub label set / Linear team. `tender.json` is gitignored. See [Config reference](config.md#config-reference).

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

Or as a systemd user service:

```bash
scripts/run.sh service
```

It writes `~/.config/systemd/user/tender.service` from `systemd/tender.service` with `WorkingDirectory` set to this clone (which holds the `.env`), `ExecStart` to your `bun`, and `PATH` to the dirs your shell resolves `bun`, `claude`, `codex`, `gh`, `nono`, `tmux` and `git` from, plus `/usr/local/bin:/usr/bin:/bin`. Run it from the shell you use tender in, and again after moving a tool. On the intake host, `scripts/run.sh intake-service` installs `tender-intake.timer` (every 15 minutes); for the weekly [PR sweep](prs.md), `scripts/run.sh prs-service` installs `tender-prs.timer` (on one host only). The units do not wait for the network (a user manager cannot order on `network-online.target`): the service logs a failed poll and tries again next poll, and restarts on failure; a timer run that fails, such as a `Persistent=true` catch-up at login before the network is up, runs again only at its next tick (a week for the PR sweep).

`KillMode=process` keeps agent sessions alive when the service restarts. `bun tender.ts status` lists sources, repos (with their `autoMerge` and `maxInReview`), a line when a `maxInReview` is reached, and one row per worktree; see [Watching sessions](watching.md#watching-sessions).

## On a VM

Same steps on the VM (Tailscale for access), except: run `scripts/setup.sh --sandbox=none owner/repo` so `tender.json` has `"sandbox": "none"` in `defaults` (or set it per repo), and set `host` to the label you route there (`hostname -s` by default, e.g. `"host": "vm"`). With no `nono` repo, setup skips installing nono and `scripts/run.sh` does not require it, unless the VM is the intake host. Each `sandbox: "none"` repo needs the token from `claude setup-token` in `~/.claude-tender/oauth-token` (setup prints the TODO). Tickets labelled `host:vm` go there. Connect your editor with Remote-SSH to `~/agent-ws/<owner>/<name>/<ID>`.

## First-run checklist

Prove the sandbox boundaries on a throwaway repo first. Not yet exercised live, so try them there too: Linear, auto-merge (`shadow` included), an SSH `origin`, a model turn with the `setup-token` token, and failed checks outside GitHub Actions.

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
