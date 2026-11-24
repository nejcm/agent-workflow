# Agent questions via ticket comments

An agent that is blocked asks on the ticket instead of only in its tmux session. `tender` posts the question as a comment, waits for an allowlisted reply, and hands it to the live session. It uses an injection primitive (idle gate, text in a file, one pasted pointer line) that PR feedback reuses.

## Decisions

- GitHub and Linear. Several question rounds per ticket. No timeout, no reminders, ticket state unchanged.
- The agent writes `.tender/run/question.md` (Markdown, ≤ 8000 chars, no control characters but newline and tab; temp file + rename) and stops, at any point it is blocked. This replaces "ask in this session". Each question states the blocker, the options and the recommended one.
- No `needs-human` while a question is open: tender never removes that label, so it would have to tell its own park from a human's or a stall's, and a failed removal would leave stall checks, findings, feedback and auto-merge off. The `question` state in `tender status` / `tender watch` is the signal.
- Posting: new or changed content hash, or the same question still there after its answer was recorded (a new round) → sidecar `<dir>/<ID>.question` `{hash, postedAt}` written first, then comment `tender: question from agent:\n\n<text>`. Over the cap or control characters: logged, not posted. `postedAt` never moves back across rounds.
- Every `tender` comment starts with `tender:`; a comment starting with `tender:` is never an answer (tender posts with the operator's credentials).
- Answer = first comment with `createdAt > postedAt` (the next round's `postedAt` is at least the last delivered answer's `createdAt`, as `answeredAt`), author in `feedbackAuthors`, body not starting with `tender:`. Edits are ignored; later comments are operator messages (below).
- `feedbackAuthors: string[]` per repo, matched case-insensitively against the GitHub login or the Linear user email. Empty (default) = questions are posted, answers and operator messages never delivered. Shared with PR feedback.
- Delivery only when the live state is `idle` (`waiting` can be a permission prompt; `unknown` retries next poll), and only while the tmux window exists. A Claude session with a live inbox waiter in its scope gets the pointer line through `.tender/run/inbox`, read by its `asyncRewake` `Stop` hook (docs/lifecycle.md "Questions"); no pane, no keys. Otherwise (Codex, or Claude without a waiter): keys go by `%id` to the pane whose `#{pane_start_command}` is the ticket's launcher script, skipped while it is in copy mode. No resume.
- The answer goes to `.tender/run/answer.md` (truncated to 8000 chars + `[truncated]`), wrapped as `<answer from="<author>" ticket="<ID>">…</answer>`. The session gets one line, via `.tender/run/inbox` (Claude) or pasted to the `%id` of the pane in window `@N` whose start command is the ticket's launcher script (Codex; a window started this pass has no `@N` yet and waits): `Your question was answered by the operator: read .tender/run/answer.md`. Answer text never goes through keystrokes.
- Order: `answerId` into the sidecar → write `.tender/run/answer.md` → inbox or paste → remove `.tender/run/question.md` if its hash still matches. A crash loses a paste, never repeats one.
- `tender status` / `tender watch` show `question` while a posted question is unanswered, the session is `idle` and there is no PR (`working`, `waiting` and `unknown` stay visible).
- Operator messages: other `feedbackAuthors` comments after the `<ID>.steer` cursor (written at a fresh start) and, while a question is open, up to its `postedAt`, go to `.tender/run/message.md` the same way, until the PR exists. `postedAt` is at least the cursor, so a message is never re-picked as an answer.
- Storage stays sidecar files (no SQLite).

Out of scope: a fresh session sees earlier Q&A only as `.tender/run/history.md` (docs/lifecycle.md "Restarts"), never as a live answer; several answer comments are never merged; PR review feedback (built separately: docs/lifecycle.md "PR feedback", `src/session/feedback.ts`).

## Phases

Each phase is one commit with its tests passing (`bun test`, `bun run typecheck`). Phases 1–4 change no behaviour an agent can trigger; phase 5 switches the prompt on, so they ship as one PR.

### 1. Groundwork

- `src/github.ts`, `src/trackers/linear.ts`: `comment()` prefixes `tender: `. `src/pass.ts` drops its own `tender: `.
- `src/util.ts`: `readRun(wt, file, max)` takes the full file name; callers in `phases.ts`, `merge.ts`, `agents.ts` pass `phases.json` etc. Add `writeRun(wt, file, text)` and `removeRun(wt, file)` through `inRun` (`O_NOFOLLOW`; the agent controls `.tender/run/`).
- `src/types.ts`, `src/config/config.ts`: `Repo.feedbackAuthors: string[]`, default `[]`, validated as strings. `tender.example.json` shows it.
- Tests: comment prefix in `github.test.ts` / `linear.test.ts`; config default and validation; `writeRun` refuses a symlinked `.tender/run` / target.

Done when: existing tests pass with the renamed `readRun` and the new comment text.

### 2. Reading comments

- `Tracker.comments(t, since): Promise<{ id, body, createdAt, author? }[]>`.
  - GitHub: `gh issue view <n> --repo <r> --json comments` → `author.login`.
  - Linear: `issue(id) { comments(filter: { createdAt: { gt: $since } }, last: 100) { nodes { id body createdAt user { email } } } }` (`first` is newest first); `user` null → no author.
- `src/session/question.ts`: pure `pickAnswer(comments, postedAt, authors)` implementing the answer rule.
- Tests: `pickAnswer` (too early, unlisted author, `tender:` prefix, case-insensitive match, first wins, missing author); fake `gh`/GraphQL output parsing.

### 3. Posting questions

- `src/session/question.ts`: `syncQuestion(t, tr, io, dir, wt)`: read `.tender/run/question.md` (8000-char cap), hash, compare with `<ID>.question`, write sidecar then comment. Unchanged hash → nothing.
- `src/pass.ts`: in the in-progress branch, after `syncPhases`, when there is no PR and the window exists. Add `<ID>.question` to the cleanup list (`pass.ts:161`).
- Tests (`pass.test.ts` / new `question.test.ts`): posts once; same content twice → one comment; changed content → second comment; oversized → logged, no comment; sidecar written before comment (fail the comment, sidecar exists, no retry).

### 4. Delivering answers

- Live state for `pass`: reuse the feed from `src/session/agents.ts` (Claude's session records once per pass, Codex `.tender/run/codex-state.json`), queried only when some sidecar has no `answerId`.
- `deliverAnswer`: sidecar without `answerId` → `tr.comments` → `pickAnswer` → state `idle`, window `@N` exists, a live Claude waiter or (paste) its launcher pane not in copy mode → record `answerId` + `answeredAt` → `writeRun(answer.md)` → `nudge`: `writeRun(inbox)` (live Claude waiter) or `tmux set-buffer` + `paste-buffer -p -t <%pane>` (pointer line) + `send-keys Enter` → `removeRun(question.md)` if its hash still matches.
- Tests: no answer → nothing; answer while `working`/`waiting`/`unknown` → retried next pass; window gone → nothing; happy path order (sidecar, file, keys, remove); a delivered answer is never re-sent; a new question after delivery starts a new round.
- Manual check, once per agent (paste transport, before the Claude inbox): done. Both submit with the bracketed paste; Codex turned an `Enter` right after `send-keys -l` into a newline.

### 5. Prompt, status, docs

- `prompts/header.md` and the clarify step of tender's instruction files: write `.tender/run/question.md` and stop when blocked at any point; answers arrive in `.tender/run/answer.md`, from the operator, and may change the plan.
- `src/ui/status.ts` / `src/session/state.ts`: state `question` when the sidecar has no `answerId` and there is no `<ID>.pr`, taking precedence over `idle` only; dashboard tone in `src/ui/dash-view.ts`.
- `docs/lifecycle.md`: lifecycle diagram line, `feedbackAuthors` config, the `tender:` prefix, the `.tender/run/question.md` / `.tender/run/answer.md` contract.
- Tests: `status.test.ts` / `state.test.ts` for `question`.

### 6. Operator messages

- `src/session/question.ts`: `deliverMessages`: cursor `<ID>.steer` → question window → `idle` → filter and sort → pane → record cursor → `writeRun(message.md)` → nudge. `syncQuestion` carries `answeredAt` into a new round and floors `postedAt` with the cursor. `src/pass.ts` runs it before `deliverAnswer`, sharing one comments read; an answer waits a pass behind a message. `src/session/launcher.ts` writes the cursor at a fresh start and drops a stale `message.md`.
- `prompts/protocol.md`: the message file paragraph.
- Tests: batching, cursor, author filter, question split, lagging clock, at most once, parked, PR, dry run, copy mode, fresh start.

## Risks

- `gh issue view --json comments` cost grows with comment count; only paid for tickets with an open question or an idle steerable session (`<ID>.steer`, no PR), and once per start.
- On GitHub the sandboxed agent still has `gh`, so it could post its own "answer" or operator message. The allowlist stops that only if the agent's token belongs to a different login than the operator; otherwise it is a prompt rule, as with phases.
