# aw — improvements

Ideas taken from Sortie, OpenAI Symphony, Cyrus, Open SWE, Open Session, Open-Inspect (Ramp's background agents), Optio, Orchestrator.inc, Emdash, rats, and the Claude Code and Codex docs. Each one is checked against aw's constraints: no dependencies, no database, no listening port, and sessions that stay interactive and visible in the apps.

The biggest gap: **aw stops at In Review.** Review comments, CI failures, merge conflicts and crashed sessions all need a human. Almost every tool researched covers that part of the work.

## The shared primitive

Most items below are built from three small pieces, all stored as files next to the existing `<ID>.prompt.md`, `<ID>.sh` and `<ID>.ended`:

| file | written by | content |
|---|---|---|
| `<ID>.state` | agent hooks | `working` \| `idle` \| `needs-input` \| `ended` plus a timestamp; mtime = last activity |
| `<ID>.cursor` | aw | last forwarded comment id, head SHA, round counter, attempt counter |
| `<ID>.feedback-<n>.md` | aw | text to hand to the session (it never goes into keystrokes or a shell command) |

*Built for agent questions* ([docs/agent-questions.md](docs/agent-questions.md), `src/question.ts`): the `<ID>.question` sidecar is the cursor, the live state from `aw status` is the idle gate, the text goes to `.aw/answer.md`, and the pointer line goes in as a bracketed paste (`set-buffer` + `paste-buffer -p`) plus a separate `Enter` to the first pane's `%id` of the window. Item 2 reuses it (`src/feedback.ts`); item 4 should too, rather than the buffer variant below.

Injection: when the state is `idle`, run `tmux load-buffer <ID>.inject` → `paste-buffer -p -t <window>` → `send-keys Enter`. The pasted line is just `Address the feedback in <path>`. The same path works for Claude and Codex, and survives an aw restart because the cursor is a file.

## Tier 1 — do next

### 1. Hook-based session state
*Emdash (marker-tagged hooks that do nothing outside its sessions), Ramp Inspect (working/done status), Claude Code and Codex hooks.*

*Partly done:* `status` and `watch` already show working / waiting / idle (Claude via `claude agents --json`, Codex via hooks writing `.aw/codex-state.json`). Still missing: a state `aw` itself acts on in `pass` (safe injection for 2 and 3) and the saved `last_assistant_message`.

- **Why:** aw currently infers "finished" from "window gone + no PR". It can't tell idle from working from stuck-on-a-prompt, and that is the precondition for safe injection (2, 3).
- **Sketch:** `scripts/setup.sh` writes hooks into `~/.claude-aw/settings.json` and `~/.codex-aw/config.toml`. Each hook is a single shell line that exits immediately unless `$AW_STATE` is set. The launcher exports `AW_STATE` (and allows it in nono `allow_vars`).
  - Claude: `UserPromptSubmit` → `working`; `Stop` → `idle`; `Notification` (`permission_prompt`, `idle_prompt`) → `needs-input`; `SessionEnd` → `ended`.
  - Codex: `notify = ["sh","-c",…]` (`agent-turn-complete` only) → `idle`. Codex hooks (`Stop`, `PermissionRequest`, `SessionEnd`) are richer, but non-managed hooks may need trust in `/hooks` before they run unattended.
  - Bonus: `Stop` stdin carries `last_assistant_message`. Save it, and post it in the "ended without a PR" comment instead of a bare notice.
- **Cost:** about 25 lines across the launcher, `scripts/setup.sh` and `reconcileSource`.
- **Risk:** the `$AW_STATE` path must be writable inside nono, so grant the single file (or `workspaceRoot/<owner>/<name>`) rather than widening the profile.

### 2. PR review + CI feedback loop
*Sortie (CI feedback, review loop), Cyrus (CYPACK-842: acts on "changes requested"), Open SWE `/baby-sit`, Orchestrator.inc, Optio.*

*Mostly done* (README "PR feedback", `src/feedback.ts`): steps 1–4 and the idle-gated delivery in 5 through the answers primitive (`.aw/feedback.md`, cursor `<ID>.feedback`), and the round limit in 6 as one comment. Not done: re-engaging a dead session with the feedback (needs 3), the `needs-human` label (9), and moving the ticket back to In Progress, left out on purpose: the next poll finds the PR and moves it to In Review again with a second PR-link comment.

- **Why:** this is the largest manual step left.
- **Sketch:** for each In Review ticket, every tick:
  1. Run `gh pr view <branch> --json reviewDecision,reviews,comments,statusCheckRollup,mergeStateStatus,headRefOid`, plus `gh api repos/{repo}/pulls/{n}/comments` for line comments.
  2. Collect new items after the cursor, **from allowlisted authors only** (`repos[].feedbackAuthors`, already used for questions; default empty = none). A stranger's PR comment is a prompt-injection vector.
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

- **Age ordering** (Symphony): ready tickets are already taken by priority; break ties by `createdAt`.
- **Blocked-by** (Cyrus, Linear relations): skip tickets whose blocking issue isn't Done.
- **`notifyUrl`** (Sortie): POST `{id, event, url}` on pick-up, review, park, ended. One `fetch`, so ntfy.sh or Slack works with no dependency.
- **`aw check`** (Sortie CLI): validates config, `gh auth`, labels, nono profiles and the Linear key; it's the first-run checklist as code.
- **Retention sweep** (Symphony): remove worktrees of repos or sources that no longer exist in `aw.json` (after a dry-run listing).
- **`allowedCreators`** (Cyrus): only take tickets created by allowlisted users. Matters once others can label issues.
- **Verification evidence** (Ramp, Open-Inspect): a prompt-template line asking for test output and screenshots in the PR body. No code.

## From rats

*rats (sacenox/rats): a human starts the agent by hand. The agent runs `rat-king watch`, which blocks until the server has unread board news (a ticket moved to `doing`, a new inbox ticket, a new human note), prints one line and exits, and then the agent runs it again. rats has no dispatch, isolation or sandbox. Its human loop is the part worth taking.*

| # | idea | sketch |
|---|---|---|
| 15 | **Pull, not paste, for feedback** | An alternative to the tmux injection in 2 and 4. aw writes new feedback to `<worktree>/.aw/inbox.md` (readable inside the sandbox) and bumps a counter. The prompt tells the agent to read it before finishing each turn. A Claude `Stop` hook that exits 2 while `inbox.md` has unread items makes the agent pick them up without a keystroke. Codex falls back to paste. This removes the "pasting mid-turn" risk for Claude. Unverified: `Stop` exit 2 keeps a Remote Control session alive and doesn't loop. |
| 16 | **Blocked is a question, not an end** | Extends 10. `blocked: <why>` must carry the question, the options and the recommended one. aw posts it, parks with `needs-human`, and **keeps the window alive**. The human's reply comes back through 4, so the same session continues instead of restarting cold. In rats this is the main way ambiguity gets resolved; aw today turns ambiguity into a guessed PR. |
| 17 | **Out-of-scope findings become tickets** | The prompt forbids fixing or TODO-commenting bugs outside the ticket. The agent lists them in `.aw/findings.json` (`[{title, body}]`, max 5, read like `phases.json`). aw files each as an issue **without** the `agent` label, so it is never auto-picked, and links them in the PR comment. Reuses the `phases.ts` create path. Keeps PRs on scope. |

Lesson, not an item: rats enforces its board rules only in the skill (its ticket 1183 says so). aw's rule stands: anything that matters is enforced by `aw` from files it reads, and agent-written files can only hold work back.

## Hardening (see [issues.md](issues.md))

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
| Web dashboard, k8s, warm pools, snapshots, prebuilt images | Optio, Open-Inspect, Ramp | Solves cloud cold-start; a local worktree is instant. `aw watch` (terminal), `tmux attach` and the apps are the dashboard. |
| Orchestrator agent splitting work, parallel child sessions, multiplayer | Orchestrator.inc, Open-Inspect | Coordination state. Split at ticket level. |
| Claude channels, Codex app-server websocket for injection | Claude Code, Codex | Channels: research preview, needs `@modelcontextprotocol/sdk`, and shows a dev-flag dialog on every start. app-server ws: experimental. Revisit when stable; they would replace tmux paste. |
| Tickets as Markdown files in the repo | rats | Every board edit becomes a commit, and the tracker is where you and others already work. |
| One long-lived agent working ticket after ticket | rats | Context grows across tickets, there is no isolation, and two agents would share one working tree. A fresh worktree session per ticket is the point. |
| Agent-side triage of new tickets | rats | aw only sees tickets a human already marked ready; triage is the human's step. |
| Hot reload, template engine, plugins, Prometheus, SSH worker pool | Sortie, Symphony | Restart is instant; `{{x}}` replacement is enough. |

## Unverified — test before building

- `tmux paste-buffer -p` + `Enter` is accepted by the Claude Code and Codex TUIs at their idle prompt.
- `claude --continue` in a worktree resumes the same conversation **with** Remote Control; the Codex equivalent for an interactive session.
- Codex hooks: whether a pre-seeded `~/.codex-aw` config skips the `/hooks` trust review. If not, use `notify`.
- Claude `UserPromptSubmit` / `Notification` payload fields (the hooks page was read only partially).
- Whether the Remote Control session URL can be read reliably from the pane (needed for 13).
- Sortie's exact backoff constants (10 s base / 5 m cap is Symphony's spec); Optio's feedback mechanism (README claim only).

## Architecture

Deferred refactors from the 2026-11 architecture review; each pays off once the named trigger happens.

- **Ticket workspace module.** A ticket's files next to its worktree (`<ID>.sh`, `.prompt.md`, `.source`, `.ended`, `.merge`, `.pr`, `.phases.json`) are named by hand in `launcher`, `pass`, `status`, `phases`, `merge` and `github`, and the cleanup list in `pass.ts` must match every writer. One module owning the file names and cleanup pays off when `<ID>.state` / `<ID>.cursor` (above) land.
- **Tracker policy behind the tracker seam.** `pass.ts` checks the source's tracker type to decide whether ids are global (Linear) or per repo (GitHub) and whether a ticket's repo can be rejected. Each tracker adapter could declare that instead, and `github.ts` could split GitHub as tracker from GitHub as code host (`canonical`, `findPr`). Worth it when a third tracker or a second code host comes up.
- **Dashboard controller.** `dash.ts` wires small pure functions (`action`, `reduce`, `reselect`) that are tested alone, but the glue (transcript reader reset, scroll bounds, reselect after sort, timer suspend around attach) is not. A controller taking events and snapshots and returning the screen model would make that glue testable. Worth it when the dashboard grows or that glue breaks.
- **Transcript selection behind the agent seam.** Each agent adapter knows its transcript format (`cwd`), but choosing the newest owned file stays in `tail.ts` because it needs `tail.ts`'s safe file IO and moving it would create an import cycle. Moving that file IO to `util.ts` would let the agent adapter own the whole lookup.
- **GLOSSARY.md.** The domain terms (ticket, source, worktree, session, marker, phase, sidecar, transcript, live state) are only defined by the code and the README.

## Suggested order

1 → 2 (with 15) → 3 → 9 → 10 + 16 → 4 → 6 → 17, then the rest on demand. Items 1–3 together turn aw from "starts work" into "carries a ticket to an approved PR", at roughly 150 lines.

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
- rats: https://github.com/sacenox/rats (`crates/rat-king/builtins/skills/`, `src/board.rs`, ticket 1183)
- Claude Code: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/channels, https://code.claude.com/docs/en/remote-control
- Codex: https://learn.chatgpt.com/docs/hooks, https://learn.chatgpt.com/docs/config-file/config-advanced, https://learn.chatgpt.com/docs/app-server
