# Agent questions via ticket comments

An agent that is blocked asks on the ticket instead of only in its tmux session. `aw` posts the question as a comment, waits for an allowlisted reply, and hands it to the live session. It uses an injection primitive (idle gate, text in a file, one pasted pointer line) that PR feedback reuses.

## Decisions

- GitHub and Linear. Several question rounds per ticket. No timeout, no reminders, ticket state unchanged.
- The agent writes `.aw/question.md` (Markdown, ≤ 8000 chars, no control characters but newline and tab; temp file + rename) and stops, at any point it is blocked. This replaces "ask in this session".
- Posting: new or changed content hash, or the same question still there after its answer was recorded (a new round) → sidecar `<dir>/<ID>.question` `{hash, postedAt}` written first, then comment `aw: question from agent:\n\n<text>`. Over the cap or control characters: logged, not posted. `postedAt` never moves back across rounds.
- Every `aw` comment starts with `aw:`; a comment starting with `aw:` is never an answer (aw posts with the operator's credentials).
- Answer = first comment with `createdAt > postedAt` (the next round's `postedAt` is at least the last delivered answer's `createdAt`, as `answeredAt`), author in `feedbackAuthors`, body not starting with `aw:`. Later comments and edits are ignored.
- `feedbackAuthors: string[]` per repo, matched case-insensitively against the GitHub login or the Linear user email. Empty (default) = questions are posted, answers never delivered. Shared with PR feedback.
- Delivery only when the live state is `idle` (`waiting` can be a permission prompt; `unknown` retries next poll), and only while the tmux window exists. Keys go to the window's first pane by `%id` (from `list-panes`), skipped while it is in copy mode. No resume.
- The answer goes to `.aw/answer.md` (truncated to 8000 chars + `[truncated]`), wrapped as `<answer from="<author>" ticket="<ID>">…</answer>`. The session gets one pasted line, sent to the first pane's `%id` of window `@N` (a window started this pass has no `@N` yet and waits): `Your question was answered by the operator: read .aw/answer.md`. Answer text never goes through keystrokes.
- Order: `answerId` into the sidecar → write `.aw/answer.md` → paste → remove `.aw/question.md` if its hash still matches. A crash loses a paste, never repeats one.
- `aw status` / `aw watch` show `question` while a posted question is unanswered, the session is `idle` and there is no PR (`working`, `waiting` and `unknown` stay visible).
- Storage stays sidecar files (no SQLite).

Out of scope: a fresh session after a crash does not see earlier Q&A; several answer comments are never merged; PR review feedback (built separately: README "PR feedback", `src/feedback.ts`).

## Phases

Each phase is one commit with its tests passing (`bun test`, `bun run typecheck`). Phases 1–4 change no behaviour an agent can trigger; phase 5 switches the prompt on, so they ship as one PR.

### 1. Groundwork

- `src/github.ts`, `src/linear.ts`: `comment()` prefixes `aw: `. `src/pass.ts:42` drops its own `aw: `.
- `src/util.ts`: `readAw(wt, file, max)` takes the full file name; callers in `phases.ts`, `merge.ts`, `agents.ts` pass `phases.json` etc. Add `writeAw(wt, file, text)` and `removeAw(wt, file)` through `inAw` (`O_NOFOLLOW`; the agent controls `.aw/`).
- `src/types.ts`, `src/config.ts`: `Repo.feedbackAuthors: string[]`, default `[]`, validated as strings. `aw.example.json` shows it.
- Tests: comment prefix in `github.test.ts` / `linear.test.ts`; config default and validation; `writeAw` refuses a symlinked `.aw` / target.

Done when: existing tests pass with the renamed `readAw` and the new comment text.

### 2. Reading comments

- `Tracker.comments(t, since): Promise<{ id, body, createdAt, author? }[]>`.
  - GitHub: `gh issue view <n> --repo <r> --json comments` → `author.login`.
  - Linear: `issue(id) { comments(filter: { createdAt: { gt: $since } }, last: 100) { nodes { id body createdAt user { email } } } }` (`first` is newest first); `user` null → no author.
- `src/question.ts`: pure `pickAnswer(comments, postedAt, authors)` implementing the answer rule.
- Tests: `pickAnswer` (too early, unlisted author, `aw:` prefix, case-insensitive match, first wins, missing author); fake `gh`/GraphQL output parsing.

### 3. Posting questions

- `src/question.ts`: `syncQuestion(t, tr, io, dir, wt)`: read `.aw/question.md` (8000-char cap), hash, compare with `<ID>.question`, write sidecar then comment. Unchanged hash → nothing.
- `src/pass.ts`: in the in-progress branch, after `syncPhases`, when there is no PR and the window exists. Add `<ID>.question` to the cleanup list (`pass.ts:161`).
- Tests (`pass.test.ts` / new `question.test.ts`): posts once; same content twice → one comment; changed content → second comment; oversized → logged, no comment; sidecar written before comment (fail the comment, sidecar exists, no retry).

### 4. Delivering answers

- Live state for `pass`: reuse the feed from `src/agents.ts` (Claude's session records once per pass, Codex `.aw/codex-state.json`), queried only when some sidecar has no `answerId`.
- `deliverAnswer`: sidecar without `answerId` → `tr.comments` → `pickAnswer` → state `idle`, window `@N` exists, its first pane not in copy mode → record `answerId` + `answeredAt` → `writeAw(answer.md)` → `tmux set-buffer` + `paste-buffer -p -t <%pane>` (pointer line) + `send-keys Enter` → `removeAw(question.md)` if its hash still matches.
- Tests: no answer → nothing; answer while `working`/`waiting`/`unknown` → retried next pass; window gone → nothing; happy path order (sidecar, file, keys, remove); a delivered answer is never re-sent; a new question after delivery starts a new round.
- Manual check, once per agent: done. Both submit with the bracketed paste; Codex turned an `Enter` right after `send-keys -l` into a newline.

### 5. Prompt, status, docs

- `prompts/default.md` step 1: write `.aw/question.md` and stop when blocked at any point; answers arrive in `.aw/answer.md`, from the operator, and may change the plan.
- `src/status.ts` / `src/state.ts`: state `question` when the sidecar has no `answerId` and there is no `<ID>.pr`, taking precedence over `idle` only; dashboard tone in `src/dash-view.ts`.
- `README.md`: lifecycle diagram line, `feedbackAuthors` config, the `aw:` prefix, the `.aw/question.md` / `.aw/answer.md` contract.
- Tests: `status.test.ts` / `state.test.ts` for `question`.

## Risks

- `gh issue view --json comments` cost grows with comment count; only paid for tickets with an open question.
- On GitHub the sandboxed agent still has `gh`, so it could post its own "answer". The allowlist stops that only if the agent's token belongs to a different login than the operator; otherwise it is a prompt rule, as with phases.
