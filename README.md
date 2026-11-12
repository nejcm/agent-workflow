# aw — agent workflow

Move a GitHub issue or Linear ticket to **ready**, and `aw` starts a Claude Code or Codex session for it: in its own git worktree, inside the [nono](https://github.com/nolabs-ai/nono) sandbox, in a tmux window you can attach to. The agent implements the ticket, runs the tests, pushes `agent/<ID>` and opens a PR; `aw` then moves the ticket to **In Review**.

- **Watch and steer from anywhere.** Claude sessions run with Remote Control, so they show up on claude.ai/code and the Claude mobile app. Codex sessions are interactive, so they land in the ChatGPT/Codex app history. Locally: `tmux attach -t aw`, or open the worktree in your editor.
- **Runs where you are.** Directly on your machine (sandboxed by nono), or on a VM (`sandbox: "none"`, the VM is the boundary). Same code, same config.
- **No moving parts to babysit.** A small Bun + TypeScript program, no database: state is the tracker, the tmux windows and the worktrees. Polls instead of webhooks, so nothing listens on a port.
- **Your setup, read-only.** Agents use your `CLAUDE.md`, `AGENTS.md` and skills, but log in through their own config dirs (`~/.claude-aw`, `~/.codex-aw`) and cannot modify yours.

## How it works

`aw.json` has three parts: `repos`, the allowlist of GitHub repos `aw` may work on (with per-repo settings); `defaults` for those settings; and `sources`, where tickets come from (a GitHub label set over the allowlisted repos, or a Linear team). Every `pollIntervalMs` (default 60 s), for each source:

```
ready ticket ──► resolve its repo; not in `repos`, or GitHub redirects it ──► one comment, skipped
             ──► gh repo clone <owner>/<name> ~/agent-repos/<owner>/<name>.tmp-…, then rename   (first time only)
             ──► In Progress + comment "picked up on <host>"
             ──► git worktree add ~/agent-ws/<owner>/<name>/<ID> -b agent/<ID> origin/<base>
             ──► tmux window <owner>/<name>/<ID>: nono run … -- claude --remote-control … "<prompt>"
.aw/phases.json changed  ──► create / update phase sub-tickets
PR for agent/<ID> exists ──► In Review + comment with the PR link
in review, autoMerge on   ──► gh pr merge --squash --delete-branch, ticket Done; or one "not auto-merged" comment per head SHA
session ended, no PR     ──► one comment "session ended without a PR"
ticket done / closed     ──► kill window, git worktree remove
```

- **Ready** = GitHub: open + `agent` + `host:<host>` labels. Linear: `Todo` state + the same two labels.
- The `host:<host>` label decides which machine takes a ticket, so a laptop and a VM never pick up the same one. With `"defaultHost": true` this machine also takes tickets with no `host:` label at all, so on a single laptop you only need `agent`. Set it on one machine only: claiming is not atomic, so two default hosts can both start the same unlabelled ticket.
- The `agent` label is never removed, as a permanent record. On GitHub a ticket is skipped while it has `in-progress` or `in-review`; to re-run one, close its old PR and remove that label.
- Ready tickets from all sources are started most urgent first: Linear's priority (Urgent, High, Medium, Low), or on GitHub an optional label `priority:urgent|high|medium|low` (case-insensitive; the most urgent wins if several). No priority goes last; ties keep source order from `aw.json`, then tracker order. `scripts/setup.sh` does not create the `priority:*` labels.
- At most `maxConcurrent` sessions in total, and at most `repos[].maxConcurrent` per repo. Ticket text only ever goes into the prompt file, never into a shell command.

### Which repo a ticket goes to

- **GitHub:** the issue's own repo. A source polls every repo in `repos`.
- **Linear:** the first of: a ticket label `repo:owner/name`; a line `repo: owner/name` in the ticket description (first such line, at the start of a line); the same line in the ticket's project summary, then its project overview. A ticket that names no repo gets one comment and is skipped.
- The result must match a `name` in `repos` (case-insensitive; the configured spelling is then used everywhere). Otherwise the ticket gets a comment (`repo x is not in the aw allowlist`, `no repo set on this ticket`, or `… is not a valid owner/name`) and is skipped, with no worktree. Repo strings from tickets must match `owner/name` of `[A-Za-z0-9_.-]`, owner not starting with `-` or `.`, no `..`, name not `.` and not ending in `.git`, and only reach `gh`/`git` as argv.
- GitHub serves a renamed or transferred repo under its old name (asking for `zeit/next.js` returns `vercel/next.js`). So before listing a repo's issues, and before cloning or starting any ticket, `aw` checks `gh repo view <repo> --json nameWithOwner` equals the allowlisted name (case-insensitive). The check before listing is cached for 5 minutes; the one right before cloning or starting a ticket is never cached. On a mismatch the repo is skipped and logged, and a Linear ticket for it gets the rejection comment; a failed lookup skips the repo (or the start) for that poll, without a comment.
- Only Linear tickets are rejected (a GitHub ticket's repo is allowlisted by construction; a redirected one is only logged). A Linear ticket gets at most one rejection comment ever, whatever the reason and from however many sources, recorded in `<workspaceRoot>/.rejected/<ID>` before the comment is posted: a crash in between loses the comment rather than repeating it, and a failed post clears the record so the next poll retries. Starting the ticket later does not clear it.
- Each worktree has a `<ID>.source` file next to it, outside the sandbox, naming the source that started it. Only that source acts on the worktree (cleanup, in-progress and in-review checks, phases, "ended without a PR"); others ignore it. If that source is no longer in `aw.json`, the worktree is left alone and logged once per run. Nothing inside the worktree is trusted for this. A ready ticket whose `<ID>.source` names another source (configured or not) is skipped and logged; only the owner restarts it. A Linear ticket keeps the repo it was started in even if its label or description changes later; while it has a window, or a worktree or `.source` in any `<workspaceRoot>/<owner>/<name>`, it is not started in another, also when that repo has since been removed from `repos` (its worktree is then left alone).

### Phases

The default prompt has the agent plan with the `agent-orchestration` skill. It forbids any attribution (`Co-Authored-By`, "Generated with ...", emoji signatures) in commits, PR titles/bodies and ticket comments. When it splits the work into phases it writes them to `.aw/phases.json` in its worktree (git-ignored via `.aw/.gitignore`): an array of `{ key, title, body, status }`, status `todo` → `in-progress` → `done`. The agent never talks to the tracker; on every poll, for each of its in-progress and in-review tickets, `aw` mirrors the file:

- a new `key` → a sub-ticket of the parent titled `<ID>: <title>`, with no labels (GitHub: `gh issue create --parent`; Linear: child issue in `Todo`, same team);
- `in-progress` → the `in-progress` label / `In Progress` state;
- `done` → shown as in-progress while the parent is In Progress; closed / first `done` state once the PR exists, just before the parent moves to In Review. Closing children mid-session could trip Linear's team setting "auto-close parent when all sub-issues are done" and `aw` would then clean up the running session.

Phases are history, not a gate: the same session works the ticket to the PR, and the parent's lifecycle is unchanged. Sub-tickets lack the `agent` label, so they are never picked up as work, `defaultHost` included. Created refs and synced statuses live in `<workspaceRoot>/<owner>/<name>/<ID>.phases.json`, outside the sandbox, written atomically. Before creating a sub-ticket `aw` lists the parent's existing ones and adopts one with the same `<ID>: <title>` that it has no record of, so a crash or lost response between creating and recording doesn't duplicate it. Tickets in review keep syncing every poll, so a failed final sync is retried. The file is untrusted: max 64 KiB and 20 phases, `key` `[a-z0-9-]{1,40}` starting with a letter or digit, one-line title ≤ 120, body ≤ 4000; `.aw` and the file are opened without following symlinks (the directory is pinned by fd via `/proc`, so Linux only) and anything but a regular file is rejected. An invalid file is logged and skipped for that poll, and a status moving back is ignored. Cleanup leaves sub-tickets as they are.

### Auto-merge

`autoMerge` (in `defaults` or per repo) lets `aw` merge a ticket's PR; the prompt forbids the agent to merge. That is a prompt rule, not a boundary: the sandbox's GitHub token can reach `/repos/**` and `/graphql` (`gh pr create` needs GraphQL, and nono filters only method + path, not the mutation), so a prompt-injected agent can still `gh pr merge` or push to `baseBranch` itself, even with `autoMerge: "off"` or `no-automerge`. The real boundary is GitHub branch protection on `baseBranch` (required PR, required status checks); enable it. On every poll, for each in-review ticket with an open PR on `agent/<ID>`, `aw` reads `gh pr view --json …` and decides:

- `off` (default): never merges.
- `all`: merges when the PR is open, not a draft, from this repo (not a fork), targets `baseBranch`, has no conflicts, no check failed or pending (zero checks is fine), and neither the PR nor the ticket has the label `no-automerge`.
- `intelligent`: the same, plus gates `aw` computes from the PR itself. Never merged: any changed file matching a critical path, or a large change. Size is additions + deletions and changed files: small ≤ 150 lines and ≤ 5 files, medium ≤ 500 and ≤ 15, else large. Small needs nothing more (zero checks is fine). A PR that renames a file is never merged (`files` gives only the new path). Medium also needs at least one check that succeeded (skipped or neutral ones don't count), and a valid `.aw/merge.json` from the agent with `tested: true`, `confidence: "high"`, `critical: false`.

The agent writes `.aw/merge.json` (`{ "tested", "confidence": "high|medium|low", "critical", "reason" }`, max 4 KiB, read like the phases file: no symlinks, regular file only) just before opening the PR. Ticket text can steer the agent, so the file is untrusted: it can only hold a merge back (`critical: true` or `confidence: "low"` blocks any size; missing or invalid blocks medium), never let one through. Built-in critical paths (case-insensitive globs on the repo-relative path; a pattern without `/` matches the file name at any depth): `.github/**`, `**/Dockerfile*`, `docker-compose*`, `**/migrations/**`, `**/*.sql`, `package.json`, `bun.lock*`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `requirements*.txt`, `**/auth/**`, `**/*secret*`, `**/*.env*`, `**/*.pem`, `**/*.key`, `nono/**`, `aw.json`, `**/infra/**`, `**/terraform/**`, `**/deploy/**`. `criticalPaths` adds to them.

Pending checks or unknown mergeability wait silently. A merge is `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>` (never `--admin`), so a push after the decision makes it fail. Right before merging `aw` views the PR again and re-runs every gate; `gh pr merge` cannot pin the base, so a retarget after that view still races. A failed merge is logged and retried next poll, and so is a PR not yet `MERGED` after the command (merge queue). After a merge `aw` comments once, closes the GitHub issue / moves the Linear ticket to the first `done` state, and cleanup follows. A PR found merged on a later poll (also by hand) moves the ticket the same way if it is from this repo and targets `baseBranch`, which retries a failed close. A PR that is not merged gets one `not auto-merged: <reason>` comment per head SHA, recorded in `<ID>.merge` next to the worktree; it is re-evaluated every poll, so a re-run check or a removed label still lets it merge without a new commit.

## Quick start

```bash
scripts/setup.sh owner/repo   # config dirs, nono, labels, .env and aw.json from the examples, login check
scripts/run.sh                # preflight (dry run), then poll in the foreground
```

The same are available as `bun run setup owner/repo`, `bun run start`, `bun run once`, `bun run service`, `bun run status`, `bun run watch`, `bun run dry`, `bun run test` and `bun run typecheck` (`tsc --noEmit`; run `bun install` once for the dev-only `typescript` and `bun-types`). Edit `repos` and `sources` in `aw.json` before running. `scripts/run.sh once` does a single pass; `scripts/run.sh service` installs and starts the systemd user unit. The agent logins and the workspace trust dialog below are interactive; `scripts/setup.sh` prints what is still missing.

## Setup

### 1. Requirements

On `PATH`: `bun`, `git`, `gh` (logged in: `gh auth status`), `tmux`, and `claude` and/or `codex`. The default prompt needs the `agent-orchestration` skill installed globally in `~/.claude/skills` (`scripts/setup.sh` links that dir into both agent config dirs). For sandboxed repos, install nono:

```bash
curl -fsSL https://nono.sh/install.sh | sh
```

### 2. Agent config dirs and logins

```bash
scripts/setup.sh owner/repo
```

Idempotent, never overwrites real files. It creates `~/.claude-aw` and `~/.codex-aw` (symlinking your `CLAUDE.md`, `AGENTS.md`, skills), creates `~/agent-ws` and `~/agent-repos`, and creates the labels for each repo you pass. Then log the agents in — these are separate from your own sessions:

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

**GitHub:** create the labels in each repo (`scripts/setup.sh` prints these with your host name):

```bash
for l in agent in-progress in-review "host:$(hostname -s)"; do gh label create "$l" --repo owner/repo --force; done
```

**Linear:** create the labels `agent` and `host:<host>` in the team, make sure it has `Todo`, `In Progress`, `In Review`, `Done` states (or set your names in the config), and put a personal API key in `.env` (gitignored, loaded by Bun from the working directory):

```bash
cp .env.example .env
```

A Linear ticket names its GitHub repo with a label `repo:owner/name`, or a line `repo: owner/name` in its description or its project's summary or overview; otherwise it is skipped with one comment (see [Which repo a ticket goes to](#which-repo-a-ticket-goes-to)).

### 4. Config

```bash
cp aw.example.json aw.json
```

Set `host` to the name in your `host:` label, list every repo `aw` may work on under `repos` (a plain `"owner/name"` takes the `defaults`; `{ "name": "owner/name", … }` overrides them), and add one source per GitHub label set / Linear team. `aw.json` is gitignored. See [Config reference](#config-reference).

`aw` clones each repo into `<reposRoot>/<owner>/<name>` (default `~/agent-repos`) with `gh repo clone` the first time a ticket needs it, into `<path>.tmp-…` and renamed when done, so an interrupted clone is never used. If `path` exists but is not the top of its own clone (`git rev-parse --git-common-dir` is not `<path>/.git`: an interrupted clone, or a subdirectory or linked worktree of another clone), or resolves to the same directory as another repo's `path`, the ticket is not claimed and the error is logged; `aw` never deletes it, so fix or remove it (and any stale `.tmp-…` sibling) by hand. Leave the clone there, or point `repos[].path` at another clone that is also used only by `aw`. Never point it at your working clone: the sandbox gets write access to that clone's `.git` (worktree commits need it), so an agent could plant hooks or config that run when you next use it.

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

`KillMode=process` keeps agent sessions alive when the service restarts. `bun aw.ts status` lists sources, repos (with their `autoMerge`) and one row per worktree; see [Watching sessions](#watching-sessions).

### Watching sessions

Claude Code and Codex can't import a session while it runs, so observe it instead of resuming it:

- `tmux attach -t aw`: the live terminals, one window per ticket (`owner/name/ID`). Detach with `Ctrl-b d`; typing there steers the agent.
- `bun aw.ts status [--json]`: per worktree its agent, state (`running`: tmux window and no `<ID>.ended`; `ended`; `orphan`: neither), runtime (since `<ID>.sh` was written), idle (since the transcript was last written), phases `done/total` (`.aw/phases.json`, else the `<ID>.phases.json` sidecar) and PR (from Claude's `pr-link` transcript entry; `held` when `<ID>.merge` records a "not auto-merged" decision). No network calls.
- `bun aw.ts watch [--interval 5]`: the same, redrawn every few seconds until `Ctrl-C`.
- `bun aw.ts tail <ID | owner/repo/ID> [-n 20] [--no-follow]`: read-only, one line per assistant message, tool call (name and a short argument) or tool error from the newest transcript (last 256 KiB), then follows it. Claude's are `~/.claude-aw/projects/<cwd, non-alphanumerics as ->/*.jsonl`; Codex's are `~/.codex-aw/sessions/**/*.jsonl`; both are matched by the `cwd` they record, and symlinks and non-regular files are skipped. An ID with transcripts in several repos is refused; name the repo. Tool output is never printed; text is capped and stripped of control and escape characters. Works for a finished ticket whose worktree is gone, as long as its transcript is.

### On a VM

Same steps on the VM (Tailscale for access), with `"sandbox": "none"` in `defaults` (or per repo) and `"host": "vm"` in `aw.json`. Tickets labelled `host:vm` go there. Connect your editor with Remote-SSH to `~/agent-ws/<owner>/<name>/<ID>`.

## Config reference

| key | default | |
|---|---|---|
| `host` | required | matches the `host:<host>` label |
| `defaultHost` | `false` | also take tickets with no `host:` label (not other hosts') |
| `pollIntervalMs` | `60000` | min 5000 |
| `workspaceRoot` | `~/agent-ws` | worktrees (`<owner>/<name>/<ID>`), prompts, launchers, sidecars |
| `reposRoot` | `~/agent-repos` | `aw`-managed clones, `<owner>/<name>`, cloned on first use |
| `tmuxSession` | `aw` | |
| `maxConcurrent` | `2` | sessions in total |
| `repos` | required | allowlist array: `"owner/name"`, or `{ "name": "owner/name", …overrides }`; tickets for other repos are skipped |
| `repos[].path` | `<reposRoot>/<owner>/<name>` | an existing `aw`-only clone; never your working clone |
| `defaults` / `repos[].baseBranch` | `main` | |
| `defaults` / `repos[].agent` | required in one of them | `claude` \| `codex` |
| `defaults` / `repos[].sandbox` | required in one of them | `nono` \| `none` |
| `defaults` / `repos[].testCmd` | required in one of them | the agent must pass it before opening a PR |
| `defaults` / `repos[].maxConcurrent` | unlimited | sessions per repo, within the global `maxConcurrent` |
| `defaults` / `repos[].prompt` | `prompts/default.md` | template, relative to the config file |
| `defaults` / `repos[].autoMerge` | `off` | `off` \| `intelligent` \| `all`, see [Auto-merge](#auto-merge) |
| `defaults` / `repos[].criticalPaths` | `[]` | extra globs never auto-merged in `intelligent`; a per-repo list replaces the `defaults` one |
| `sources[].name` | required | `[a-z0-9-]`, unique |
| `sources[].tracker` | required | `github` \| `linear` |
| GitHub: `readyLabel`, `inProgressLabel`, `inReviewLabel` | `agent`, `in-progress`, `in-review` | done = issue closed |
| Linear: `team`, `todo`, `inProgress`, `inReview`, `done` | —, `Todo`, `In Progress`, `In Review`, `[Done, Canceled, Duplicate]` | `team` is the key, e.g. `ENG` |

Prompt placeholders: `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{testCmd}} {{repo}}`; `base`, `testCmd` and `repo` come from the ticket's repo settings.

### Upgrading from the `repos` map

`repos` used to be an object keyed by `"owner/name"`; that form is rejected at startup. Turn each `"owner/name": {}` into `"owner/name"` and each `"owner/name": { … }` into `{ "name": "owner/name", … }`. `sources[].repos` is gone (rejected at startup): a GitHub source polls every repo in `repos`. Worktrees moved from `<workspaceRoot>/<owner>__<name>/<ID>` to `<workspaceRoot>/<owner>/<name>/<ID>`; old ones are not seen any more. Finish or close those tickets first, or remove them by hand (`git -C <clone> worktree remove <old>`, then the `<ID>.*` files). To keep one, first stop its session (`tmux kill-window -t 'aw:<owner>__<name>/<ID>'`; `aw` would not recognise the old window name and would start a second session), then `git -C <clone> worktree move <old> <new>`, move `<ID>.phases.json` and `<ID>.source` alongside (create `<ID>.source` with the source name if there is none), and delete `<ID>.sh` and `<ID>.prompt.md`: they hold the old absolute paths and are regenerated when the ticket starts again. Move the ticket back to ready to resume in the moved worktree.

### Upgrading from `lanes`

`lanes` is rejected at startup. Move each lane's `repo` into `repos` (with its `repoPath` as `path`, plus `baseBranch`, `agent`, `sandbox`, `testCmd`, `maxConcurrent`, `prompt`) and keep the rest (`name`, `tracker`, labels, Linear states and `team`) as a source; Linear tickets or projects must now name their repo. Worktrees in the old `<workspaceRoot>/<lane>/<ID>` layout are not seen any more: finish or close those tickets first, or remove them by hand (`git -C <clone> worktree remove <workspaceRoot>/<lane>/<ID>`, then the `<ID>.*` files).

CLI: `bun aw.ts <run|once|status|watch|tail> [--dry-run] [--json] [--interval s] [-n N] [--no-follow] [--config aw.json]`.

## Code layout

- `aw.ts`: CLI entry (`run`, `once`, `status`, `watch`, `tail`).
- `src/types.ts`: shared types (`Config`, `Repo`, `Source`, `Ticket`, `Tracker`, `Io`).
- `src/config.ts`: `aw.json` parsing and the repo allowlist.
- `src/github.ts`, `src/linear.ts`: tracker adapters, priority, canonical-repo lookup.
- `src/phases.ts`: `.aw/phases.json` validation and sub-ticket sync.
- `src/merge.ts`: `.aw/merge.json`, critical paths, the merge decision and auto-merge.
- `src/launcher.ts`: clone, worktree, prompt and launcher script, tmux window.
- `src/pass.ts`: one poll: cleanup, start ready tickets by priority, reconcile.
- `src/status.ts`: per-worktree status rows and the table.
- `src/tail.ts`: transcript lookup, line condensing and control-char stripping, `tail`.
- `src/util.ts`: logged/dry-run-aware command and file helpers, the pinned `.aw` reader.
- `tests/`: one file per module (launcher tests are in `pass.test.ts`); shared fakes in `tests/helpers.ts`.

## First-run checklist

The nono profiles have not been run yet; prove the boundaries on a throwaway repo first.

- [ ] Inside a sandboxed session, `cat ~/.ssh/id_*`, `ls ~/Work/<other-repo>`, `ls ~/.config` fail.
- [ ] Writing `~/.claude/CLAUDE.md` or `~/.claude/settings.json` fails; your CLAUDE.md, AGENTS.md and skills load.
- [ ] `env | grep -iE 'token|key'` shows only phantom values; `LINEAR_API_KEY` is absent.
- [ ] `git push -u origin agent/<ID>` and `gh pr create` work, also with an SSH `origin`.
- [ ] Sandboxed Codex reaches its backend (`chatgpt.com`, `auth.openai.com`).
- [ ] Claude session is visible and steerable on claude.ai/code / mobile; Codex session is in the app history.
- [ ] Inside a sandboxed session, writing another clone's `.git` under `~/agent-repos` fails; only this ticket's clone `.git` is granted.
- [ ] A Linear ticket for a repo not in `repos` gets one comment and no worktree, also after restarting `aw`.
- [ ] Issue → PR → `in-review`; closing the issue removes the window and the worktree.

## Known gaps

- **Unverified:** nono's GitHub credential route for `git push`; whether `gh`'s endpoint rules are wide enough; Remote Control endpoints beyond `claude.ai` from inside the sandbox; Linear `issue(id: "ENG-42")` lookup and filter shape; Linear `project { description content }` against a live workspace (field names checked against the published schema only), whether Linear stores `repo: owner/name` lines with Markdown escapes (e.g. `my\_repo`, which is then rejected), and label names containing `/`; `gh repo clone` into a nested path on first use; whether trusting `~/agent-ws` covers worktrees below it; phase sub-tickets against live services (`gh issue create --parent`, `gh api …/sub_issues`, Linear `children`, Linear `issueCreate` with `parentId`, and that Linear adds no default labels to child issues); Codex picking up skills from `~/.codex-aw/skills`; that `gh repo view --json nameWithOwner` reports the new name for a renamed or transferred repo.
- **Phase side effects:** with Linear's "auto-close parent when all sub-issues are done", the parent can still close when the PR opens (the final sync closes the children); `aw` then moves it to In Review, but if Linear applies the auto-close later the parent ends Done and `aw` cleans up the finished session. Turn that setting off for `aw` teams. Adopting an orphaned sub-ticket matches on title, so two phases with the same title can share one sub-ticket after a crash. On GitHub the sandboxed agent still has `gh` access, so "never touches the tracker" is a prompt rule there, not a boundary.
- **Clones are agent-writable:** the sandbox grants `<clone>/.git` (worktree commits need it), so an agent could plant `.git/hooks` that later run outside the sandbox, including in `aw`'s own `git fetch` / `worktree` calls and other tickets' sessions on that repo. Keep clones `aw`-only (the `reposRoot` default); never set `path` to your working clone.
- **Token scope:** the GitHub credential comes from `gh auth token` (all your scopes). Prefer a fine-grained token limited to the allowlisted repos.
- **One failing repo stops its source's listing:** a GitHub source lists its repos one by one, so a `gh issue list` error on one (no access) skips that poll's ready/in-progress lists for the whole source; it is logged. A renamed repo or a failed name lookup only skips that repo.
- **Codex under nono runs with `--no-daemon`** (required on Linux), so sandboxed Codex sessions show in the app history but can't be live-steered; with `sandbox: "none"` they can.
- **Claude sessions can run Codex:** the Claude profile also grants `~/.codex-aw`, `CODEX_HOME`, `chatgpt.com` and `auth.openai.com`, so `agent-orchestration` can delegate to Codex. This widens the sandbox: a session can read the agent's Codex login (a long-lived ChatGPT refresh token) and rewrite `~/.codex-aw/config.toml`, so a prompt-injected Claude session can plant code that later Codex sessions run. Claude and Codex sessions now share one trust domain. Remove those entries if you don't want it.
- **Auto-merge:** unverified against live GitHub: `statusCheckRollup` item shapes (CheckRun `status`/`conclusion`, StatusContext `state`) and `mergeable` turning `UNKNOWN` → `MERGEABLE`; `gh issue close` on an issue `Closes #n` already closed. A small PR whose CI has not registered any check yet counts as "zero checks" and can merge at once. Branch protection that blocks the merge (required reviews) makes it fail and be logged every poll.
- **Safety rests on the sandbox:** agents run with `bypassPermissions` / `--ask-for-approval never`.
- **List limit with `defaultHost`:** each poll fetches at most 100 tickets per query (per repo on GitHub). With `defaultHost` the host filter is applied client-side (no query can express "no `host:` label"), so more than 100 ready tickets for other hosts can hide unlabelled ones.
- **One `aw` per tracker and workspace:** a single `aw run` polls sequentially, and the checks that keep a ticket to one repo and one session are not atomic across processes. Two `aw` instances on the same tracker or `workspaceRoot` are unsupported; use `host:` labels to split work between machines.
- A launch that fails after claiming leaves the ticket in progress with a "session ended" comment; PR review comments are not fed back into the session yet.
