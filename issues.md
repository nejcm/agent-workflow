# aw — known issues

Bugs, gaps, accepted trade-offs and unverified assumptions in the current code. New behaviour and refactors are in [improvements.md](improvements.md).

## Bugs

- **A half-done claim strands the ticket.** `claim` sets the state or label, then comments (`src/github.ts`, `src/linear.ts`). If the comment fails, `start` kills the window but the ticket is already In Progress, so the next poll comments "session ended without a PR" and it needs a human.
- **A failed claim can leave an unclaimed session running.** If `claim` fails and killing the window also fails (`src/launcher.ts`), the session keeps running, its ticket stays ready and is skipped while the window exists, and the window is not counted against the concurrency limits for the rest of that poll. The log names the window; kill it by hand.
- **`aw tail` keeps following the first transcript.** With follow on, `tail` pins the path it opened (`src/tail.ts`), so a session that starts a new transcript file (restart, `/clear`) goes quiet. The dashboard already switches to the newer file.
- **`held` can outlive a head change for one poll.** If the PR head moves between `autoMerge`'s two `gh pr view` calls, the old `<ID>.merge` stays until the next poll clears it.
- **`<ID>.pr` is not refreshed with `autoMerge: off` once the session is gone.** An In Review ticket with no tmux window looks up its PR only while `<ID>.pr` is missing, so a replaced PR keeps showing the old link.
- **`unknown` has two colours in the dashboard.** The state badge uses `bad`, the progress bar `idle` (`src/dash-view.ts`, `TONE` vs `barTone`). Undecided whether that is intended.

## Gaps

- **Clones are agent-writable:** the sandbox grants `<clone>/.git` (worktree commits need it), so an agent could plant `.git/hooks` that later run outside the sandbox, including in `aw`'s own `git fetch` / `worktree` calls and other tickets' sessions on that repo. Keep clones `aw`-only (the `reposRoot` default); never set `path` to your working clone.
- **Token scope:** the GitHub credential comes from `gh auth token` (all your scopes). Prefer a fine-grained token limited to the allowlisted repos.
- **Safety rests on the sandbox:** agents run with `bypassPermissions` / `--ask-for-approval never`.
- **Claude sessions can run Codex:** the Claude profile also grants `~/.codex-aw`, `CODEX_HOME`, `chatgpt.com` and `auth.openai.com`, so `agent-orchestration` can delegate to Codex. This widens the sandbox: a session can read the agent's Codex login (a long-lived ChatGPT refresh token) and rewrite `~/.codex-aw/config.toml`, so a prompt-injected Claude session can plant code that later Codex sessions run. Claude and Codex sessions share one trust domain. Remove those entries if you don't want it.
- **Phase side effects:** with Linear's "auto-close parent when all sub-issues are done", the parent can still close when the PR opens (the final sync closes the children); `aw` then moves it to In Review, but if Linear applies the auto-close later the parent ends Done and `aw` cleans up the finished session. Turn that setting off for `aw` teams. Adopting an orphaned sub-ticket matches on title, so two phases with the same title can share one sub-ticket after a crash. On GitHub the sandboxed agent still has `gh` access, so "never touches the tracker" is a prompt rule there, not a boundary.
- **Auto-merge:** `gh pr merge` pins the head but not the base, so a retarget after `aw`'s last view still races. A small PR whose CI has not registered any check yet counts as "zero checks" and can merge at once. Branch protection that blocks the merge (required reviews) makes it fail and be logged every poll.
- **One failing repo stops its source's listing:** a GitHub source lists its repos one by one, so a `gh issue list` error on one (no access) skips that poll's ready/in-progress lists for the whole source; it is logged. A renamed repo or a failed name lookup only skips that repo.
- **List limit with `defaultHost`:** each poll fetches at most 100 tickets per query (per repo on GitHub). With `defaultHost` the host filter is applied client-side (no query can express "no `host:` label"), so more than 100 ready tickets for other hosts can hide unlabelled ones.
- **One `aw` per tracker and workspace:** a single `aw run` polls sequentially, and the checks that keep a ticket to one repo and one session are not atomic across processes. Two `aw` instances on the same tracker or `workspaceRoot` are unsupported; use `host:` labels to split work between machines.
- **Codex under nono runs with `--no-daemon`** (required on Linux), so sandboxed Codex sessions show in the app history but can't be live-steered; with `sandbox: "none"` they can.
- **Questions, self-answers:** on GitHub the sandboxed agent shares the operator's `gh` login, so it could post an "answer" from an allowlisted login; only a comment starting with `aw:` is excluded. It is a prompt rule unless the agent's token is a different account.
- **Questions, clock skew:** `postedAt` is the local clock, `createdAt` the tracker's. A local clock behind the tracker can make an answer picked but not yet delivered (session busy) count for a new question too. A delivered answer is safe: `postedAt` never moves back, so every later round starts at or after its `createdAt`.
- **Questions, clock ahead:** with the local clock N seconds ahead of the tracker, an answer posted within N seconds of the question is missed (Linear also filters it out server-side); reply again.
- **Questions, Linear window:** `comments(filter: createdAt > postedAt, last: 100)`; more than 100 non-answer comments after a question would hide the answer.
- **PR feedback, self-feedback:** on GitHub the agent shares the operator's `gh` login, so a PR comment it posts counts as the operator's and is fed back to it as a new round (bounded by the 3-round limit). Not replying on the PR is a prompt rule.
- **PR feedback, dead sessions:** feedback reaches only a session whose window exists; a crashed or closed session gets nothing and nothing is logged (improvements.md, item 3).
- **PR feedback, windows:** only the first 100 line comments (`gh api …/pulls/<n>/comments?per_page=100`) are read. A comment edited after delivery, or created at the same millisecond as the cursor, is not sent. A conflict that appears for a head SHA already reported as conflicting is not sent again; only the last 10 reported SHAs are remembered.
- **PR feedback, round limit:** 3 rounds per ticket, a constant (`MAX_ROUNDS` in `src/feedback.ts`), never reset; after the "human is needed" comment the ticket gets no more feedback until its `<ID>.feedback` is deleted.

## Accepted trade-offs

- A row's PR appears only after the next poll finds it (`<ID>.pr`), not the moment the agent opens it.
- With `autoMerge: off`, an In Review ticket without a PR costs one `gh pr list` per poll until it has one.
- An In Review ticket with a live window costs one `gh pr list` and one `gh pr view` per poll, plus one `gh api` for line comments when `feedbackAuthors` is set; `gh run view --log-failed` only on delivery.
- Auto-merge holds on any reviewer's "changes requested" (`reviewDecision`), but not on undelivered plain comments: an allowlisted PR comment on a green PR can be merged past; add `no-automerge` to stop it.
- A failed CI log fetch (or a gh error, masked by the `tail` pipe) shows as "(log unavailable)".
- PR feedback is pasted at most once per round, like answers: a crash or failed write or paste after the cursor is recorded loses that round.
- Checks are reported only when none is pending, so a slow check delays the failed ones on the same head; a check that fails after a re-run on the same head SHA is not reported again.
- `aw tail` and `status` read only the last 256 KiB of a transcript.
- An answer is pasted at most once: a crash or failed write or `send-keys` after its id is recorded loses the paste. The question file is still there, so the next poll posts it again as a new round and the previous answer does not count for it.
- A crash between the paste and removing `.aw/question.md` reposts the question once, although the agent got the answer.
- The live state is read once per poll (Claude: one `claude agents --json`), so the session may have left `idle` by the time the line is pasted. A pane in copy mode is skipped until the next poll.
- The agent's pane is taken to be the window's lowest-index pane, so after `split-window -b` or `swap-pane` in that window the line can land in another pane. The agent then never sees it; the next poll reposts the question as a new round.
- An open question costs one comments call (`gh issue view --json comments` / Linear GraphQL) per poll until it is answered; none when `feedbackAuthors` is empty.
- A modal at idle takes the answer's keys: An idle session can still show a dialog (Codex's "switch to a cheaper model" rate-limit prompt was seen live); the pasted line and `Enter` then go to it, e.g. selecting its first option. The question is lost to the at-most-once paste and is reposted.
- Codex delivery needs aw's state hooks: Without them in `~/.codex-aw/config.toml` (`scripts/setup.sh`) a Codex session never reads as `idle`, so answers are never delivered.

## Unverified

Never exercised end-to-end: the nono profiles (run the README's first-run checklist on a throwaway repo first), and live Claude, Codex and GitHub runs of the status, PR and auto-merge paths. Also unchecked against live services:

- nono's GitHub credential route for `git push`; whether `gh`'s endpoint rules are wide enough; Remote Control endpoints beyond `claude.ai` from inside the sandbox.
- Linear: `issue(id: "ENG-42")` lookup and filter shape; `project { description content }` (field names checked against the published schema only); whether `repo: owner/name` lines are stored with Markdown escapes (e.g. `my\_repo`, which is then rejected); label names containing `/`.
- `gh repo clone` into a nested path on first use; whether trusting `~/agent-ws` covers worktrees below it; that `gh repo view --json nameWithOwner` reports the new name for a renamed or transferred repo.
- Phase sub-tickets: `gh issue create --parent`, `gh api …/sub_issues`, Linear `children`, Linear `issueCreate` with `parentId`, and that Linear adds no default labels to child issues.
- Codex picking up skills from `~/.codex-aw/skills`.
- Questions: that `gh issue view --json comments` returns every comment; Linear's `last` ordering on `comments`. (Checked live: the bracketed paste plus `Enter` submits in Claude Code and Codex; plain `send-keys -l` plus an immediate `Enter` does not submit in Codex.)
- PR feedback: `mergeStateStatus` reaching `DIRTY` for a conflicting PR; `gh run view --log-failed` output on a finished run; checks outside GitHub Actions (no run id, so no log). Checked live against a public PR: `reviews[]` (`id`, `author.login`, `body`, `state`, `submittedAt`), `comments[]` (`createdAt`, `author.login`), CheckRun `detailsUrl` `…/actions/runs/<id>/job/<id>`, REST line comments (`id`, `user.login`, `created_at`, `path`, `line`/`original_line`). The full loop (paste, agent pushes a fix) has not run end-to-end.
- Auto-merge: `statusCheckRollup` item shapes (CheckRun `status`/`conclusion`, StatusContext `state`), `mergeable` turning `UNKNOWN` → `MERGEABLE`, and `gh issue close` on an issue `Closes #n` already closed.

## Tests

- `tests/dash.test.ts` drives the dashboard in a real tmux pane, so it fails in sandboxes without tmux or a TTY.
