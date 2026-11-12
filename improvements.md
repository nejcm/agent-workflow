# aw — improvements

Ideas taken from Sortie, OpenAI Symphony, Cyrus, Open SWE, Open Session, Open-Inspect (Ramp's background agents), Optio, Orchestrator.inc, Emdash, and the Claude Code and Codex docs. Each one is checked against aw's constraints: no dependencies, no database, no listening port, and sessions that stay interactive and visible in the apps.

The biggest gap: **aw stops at In Review.** Review comments, CI failures, merge conflicts and crashed sessions all need a human. Almost every tool researched covers that part of the work.

## The shared primitive

Most items below are built from three small pieces, all stored as files next to the existing `<ID>.prompt.md`, `<ID>.sh` and `<ID>.ended`:

| file | written by | content |
|---|---|---|
| `<ID>.state` | agent hooks | `working` \| `idle` \| `needs-input` \| `ended` plus a timestamp; mtime = last activity |
| `<ID>.cursor` | aw | last forwarded comment id, head SHA, round counter, attempt counter |
| `<ID>.feedback-<n>.md` | aw | text to hand to the session (it never goes into keystrokes or a shell command) |

Injection: when the state is `idle`, run `tmux load-buffer <ID>.inject` → `paste-buffer -p -t <window>` → `send-keys Enter`. The pasted line is just `Address the feedback in <path>`. The same path works for Claude and Codex, and survives an aw restart because the cursor is a file.

## Tier 1 — do next

### 1. Hook-based session state
*Emdash (marker-tagged hooks that do nothing outside its sessions), Ramp Inspect (working/done status), Claude Code and Codex hooks.*

- **Why:** aw currently infers "finished" from "window gone + no PR". It can't tell idle from working from stuck-on-a-prompt, and that is the precondition for safe injection (2, 3).
- **Sketch:** `setup.sh` writes hooks into `~/.claude-aw/settings.json` and `~/.codex-aw/config.toml`. Each hook is a single shell line that exits immediately unless `$AW_STATE` is set. The launcher exports `AW_STATE` (and allows it in nono `allow_vars`).
  - Claude: `UserPromptSubmit` → `working`; `Stop` → `idle`; `Notification` (`permission_prompt`, `idle_prompt`) → `needs-input`; `SessionEnd` → `ended`.
  - Codex: `notify = ["sh","-c",…]` (`agent-turn-complete` only) → `idle`. Codex hooks (`Stop`, `PermissionRequest`, `SessionEnd`) are richer, but non-managed hooks may need trust in `/hooks` before they run unattended.
  - Bonus: `Stop` stdin carries `last_assistant_message`. Save it, and post it in the "ended without a PR" comment instead of a bare notice.
- **Cost:** about 25 lines across the launcher, `setup.sh` and `reconcileSource`.
- **Risk:** the `$AW_STATE` path must be writable inside nono, so grant the single file (or `workspaceRoot/<owner>/<name>`) rather than widening the profile.

### 2. PR review + CI feedback loop
*Sortie (CI feedback, review loop), Cyrus (CYPACK-842: acts on "changes requested"), Open SWE `/baby-sit`, Orchestrator.inc, Optio.*

- **Why:** this is the largest manual step left.
- **Sketch:** for each In Review ticket, every tick:
  1. Run `gh pr view <branch> --json reviewDecision,reviews,comments,statusCheckRollup,mergeStateStatus,headRefOid`, plus `gh api repos/{repo}/pulls/{n}/comments` for line comments.
  2. Collect new items after the cursor, **from allowlisted authors only** (`repos[].feedbackAuthors`, default = the repo owner). A stranger's PR comment is a prompt-injection vector.
  3. Failing checks: append `gh run view <id> --log-failed | tail -n 80`, but only once per head SHA. `mergeStateStatus == DIRTY`: add "rebase on origin/<base> and resolve conflicts".
  4. Debounce: act only when the newest item is older than ~2 min, so a reviewer who is still typing gets batched.
  5. If state is `idle`, write `feedback-<n>.md`, inject it, move the ticket back to In Progress and bump the round counter. If the window is gone, go to 3 (re-engage) with the feedback as the prompt.
  6. After `maxRounds` (default 3), add a `needs-human` label, post one comment, and stop.
- **Cost:** about 80 lines plus tests using a fake `gh`.
- **Risk:** pasting into a TUI mid-turn. Gate on `idle` from (1), and test bracketed paste in both CLIs before trusting it.

### 3. Re-engage dead sessions
*Sortie/Symphony (retry with backoff, `max_attempts`), Ramp (snapshot per prompt so follow-ups resume).*

- **Why:** a crash, reboot or OOM today ends in "session ended without a PR", and a human has to relabel.
- **Sketch:** state is not `ended`-by-user (or `.ended` has a non-zero exit), the window is gone, and the worktree exists → relaunch the same `<ID>.sh` with `claude --continue` / Codex resume. Store the attempt count and next-allowed time in the cursor (backoff 1m → 5m → 15m). After `maxAttempts` (default 2) → `needs-human`.
- **Cost:** about 30 lines, plus a `resume` flag in the launcher template.
- **Risk:** `--continue` picks "the most recent conversation in this directory". That's fine because each worktree has exactly one session, but confirm it keeps `--remote-control`. Which Codex resume command fits an interactive session is unverified.

### 4. Comment-driven follow-ups on the ticket
*Cyrus (new comments reach the running session), Open-Inspect (@mention on PRs).*

- **Why:** steering from the tracker, e.g. from your phone in Linear, without opening claude.ai.
- **Sketch:** same code path as (2), sourced from ticket comments after the "picked up" comment (whose id is the initial cursor). Forward only allowlisted authors, and on PRs only comments starting with `@agent`.
- **Cost:** about 20 lines on top of (2).

## Tier 2 — worth it, smaller

| # | idea | from | sketch |
|---|---|---|---|
| 5 | **Stop / cancel** | Cyrus | Ticket moves to Canceled while In Progress → `send-keys C-c` twice, kill the window, keep the worktree (data). Cleanup stays tied to Done, as now. |
| 6 | **Per-repo setup / teardown hook** | Sortie workspace hooks, Cyrus `cyrus-setup.sh`, Open Session `.agents/setup`, Emdash `scripts.setup/teardown` | If `<worktree>/.aw/setup.sh` exists, run it inside the sandbox before the agent starts, with `AW_ID`, `AW_TITLE`, `AW_PORT`. Teardown is time-boxed and non-fatal before `git worktree remove`. |
| 7 | **Port per session** | Emdash (unconfirmed how) | `AW_PORT = repo.portBase + slot`, where slot is the index of the worktree in the sorted list, so two dev servers don't collide. |
| 8 | **Stall detection** | Sortie, Symphony | State `working` but its mtime (or tmux `#{window_activity}`) is older than `stallMinutes` (default 30) → one ticket comment with the last pane lines (`capture-pane -p -S -20`). No auto-kill. |
| 9 | **`needs-human` park label** | Sortie, Symphony | One label used by 2, 3, 8 and `needs-input`. aw skips parked tickets until a human removes the label. Linear: a label, not a state. |
| 10 | **Handoff status file** | Sortie (handoff evidence) | The prompt tells the agent to write `.aw/status` = `pr` \| `blocked: <why>` \| `no-change-needed: <why>`. aw posts the reason and parks the ticket instead of "ended without a PR". It also rejects a PR with an empty diff. |
| 11 | **Label-driven modes** | Cyrus `labelPrompts` | `agent:codex`, `agent:claude`, `model:<id>`, `mode:plan` labels override the repo's agent, model or prompt (`prompts/<mode>.md`). Labels are tracker-controlled; the values are validated against an allowlist, never interpolated. |
| 12 | **Merge → Done** | Sortie | GitHub closes linked issues already (`Closes #n`). For Linear, check `gh pr view --json mergedAt`; if merged, set Done and the existing cleanup runs. |
| 13 | **Linear: attach session + PR links** | Linear API (`attachmentLinkURL`) | On pick-up, attach the claude.ai/code session URL (if it can be read from the pane) and the PR, so the ticket links straight to the live session. A personal key is enough; no OAuth app is needed. |
| 14 | **Attachments / images** | Cyrus | Download ticket image URLs into `<worktree>/.aw/attachments/` and list them in the prompt. GitHub user-attachment URLs need the token; skip private ones on failure. |

## Tier 3 — only if needed

- **Priority/age ordering** (Symphony): sort ready tickets by priority, then `createdAt`, before taking `maxConcurrent`.
- **Blocked-by** (Cyrus, Linear relations): skip tickets whose blocking issue isn't Done.
- **`notifyUrl`** (Sortie): POST `{id, event, url}` on pick-up, review, park, ended. One `fetch`, so ntfy.sh or Slack works with no dependency.
- **`aw status --json`** and **`aw check`** (Sortie CLI): check validates config, `gh auth`, labels, nono profiles and the Linear key; it's the first-run checklist as code.
- **Retention sweep** (Symphony): remove worktrees of repos or sources that no longer exist in `aw.json` (after a dry-run listing).
- **`allowedCreators`** (Cyrus): only take tickets created by allowlisted users. Matters once others can label issues.
- **Verification evidence** (Ramp, Open-Inspect): a prompt-template line asking for test output and screenshots in the PR body. No code.

## Hardening (from README "Known gaps")

- Clones are `aw`-managed (`reposRoot`), but one clone is shared by every session on that repo and by `aw`'s own `git` calls, so `.git/hooks` planted by one agent still run outside its sandbox. Next step: a clone per session, or `core.hooksPath=/dev/null` on `aw`'s git calls.
- Fine-grained PAT per repo instead of `gh auth token`.
- The sandbox token can merge PRs (REST `PUT …/pulls/*/merge` or the GraphQL `mergePullRequest` mutation) and push to `baseBranch`, so `autoMerge` gates are advisory against a prompt-injected agent. nono's endpoint rules match method + path only and `gh pr create` needs `POST /graphql`, so the profile can't block it. Options: a token without merge rights (likely none: GitHub lists merging under the same Contents: write that push needs; unverified), have `aw` open the PR so the sandbox drops `/graphql`, or rely on branch protection with required checks.
- Make `~/.codex-aw` read-only in `nono/aw-claude.json`, writable only for what Codex needs (sessions, `*.sqlite`, log, tmp, cache, `auth.json*`), so a Claude session can't rewrite `config.toml` for later Codex sessions. Untested whether Codex runs that way.
- Every injection path above (2, 4, 11, 14) adds tracker text that a session reads. Keep the rule that this text goes only into files, and author allowlists default to the owner.

## Do not copy

| thing | seen in | why not |
|---|---|---|
| SQLite / Postgres state | Sortie, Optio, Open-Inspect | Tracker + tmux + files already hold it; a DB adds migrations and drift. |
| Webhooks, tunnels, Slack/HTTP triggers | Cyrus, Open-Inspect, Optio (14 trigger types) | Needs a listening port; polling every 60 s is fine for tickets. |
| Linear OAuth agent identity, `AgentSessionEvent`, streaming thoughts to Linear | Cyrus, Linear Agent API | Needs an OAuth app, a public URL and a webhook secret. Comments + attachments cover the useful part. |
| Headless `stream-json` / Agent SDK runs | Sortie, Cyrus | Loses visibility in claude.ai/code and the ChatGPT app, which is the reason aw exists. |
| Token / cost accounting | Sortie, Symphony | Not readable from interactive sessions; `maxAttempts` + `maxRounds` bound spend instead. |
| Auto-merge | Optio, Sortie | Merging stays a human decision. |
| Dashboard, k8s, warm pools, snapshots, prebuilt images | Optio, Open-Inspect, Ramp | Solves cloud cold-start; a local worktree is instant. `tmux attach` + the apps are the dashboard. |
| Orchestrator agent splitting work, parallel child sessions, multiplayer | Orchestrator.inc, Open-Inspect | Coordination state. Split at ticket level. |
| Claude channels, Codex app-server websocket for injection | Claude Code, Codex | Channels: research preview, needs `@modelcontextprotocol/sdk`, and shows a dev-flag dialog on every start. app-server ws: experimental. Revisit when stable; they would replace tmux paste. |
| Hot reload, template engine, plugins, Prometheus, SSH worker pool | Sortie, Symphony | Restart is instant; `{{x}}` replacement is enough. |

## Unverified — test before building

- `tmux paste-buffer -p` + `Enter` is accepted by the Claude Code and Codex TUIs at their idle prompt.
- `claude --continue` in a worktree resumes the same conversation **with** Remote Control; the Codex equivalent for an interactive session.
- Codex hooks: whether a pre-seeded `~/.codex-aw` config skips the `/hooks` trust review. If not, use `notify`.
- Claude `UserPromptSubmit` / `Notification` payload fields (the hooks page was read only partially).
- Whether the Remote Control session URL can be read reliably from the pane (needed for 13).
- Sortie's exact backoff constants (10 s base / 5 m cap is Symphony's spec); Optio's feedback mechanism (README claim only).

## Suggested order

1 → 2 → 3 → 9 → 10 → 4 → 6, then the rest on demand. Items 1–3 together turn aw from "starts work" into "carries a ticket to an approved PR", at roughly 150 lines and still no dependencies.

## Sources

- Sortie: https://github.com/sortie-ai/sortie, https://docs.sortie-ai.com/guides/configure-ci-feedback/, https://docs.sortie-ai.com/guides/setup-workspace-hooks/, https://docs.sortie-ai.com/reference/workflow-config/
- Symphony: https://github.com/openai/symphony/blob/main/SPEC.md
- Cyrus: https://github.com/ceedaragents/cyrus (CHANGELOG, CYPACK-842)
- Open SWE: https://github.com/langchain-ai/open-swe
- Open Session: https://github.com/tellahq/opensession
- Linear API: https://linear.app/developers
- Open-Inspect: https://github.com/open-inspect/background-agents · Ramp: https://builders.ramp.com/post/why-we-built-our-background-agent
- Optio: https://github.com/jonwiggins/optio
- Orchestrator.inc: https://github.com/OrchestratorInc/agent-orchestrator
- Emdash: https://github.com/generalaction/emdash (ADR 0003)
- Claude Code: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/channels, https://code.claude.com/docs/en/remote-control
- Codex: https://learn.chatgpt.com/docs/hooks, https://learn.chatgpt.com/docs/config-file/config-advanced, https://learn.chatgpt.com/docs/app-server
