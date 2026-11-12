# aw — known issues

Bugs, gaps, accepted trade-offs and unverified assumptions in the current code. New behaviour and refactors are in [improvements.md](improvements.md).

## Bugs

- **A failed launch strands the ticket.** `launch` claims the ticket (`tr.claim`) before `git fetch`, the worktree and the tmux window (`src/launcher.ts`). If any of those fail, the ticket stays In Progress with a "session ended without a PR" comment and needs a human. Fix: claim last, or move the ticket back to ready on failure.
- **`aw tail` keeps following the first transcript.** With follow on, `tail` pins the path it opened (`src/tail.ts`), so a session that starts a new transcript file (restart, `/clear`) goes quiet. The dashboard already switches to the newer file.
- **`held` can outlive a head change for one poll.** If the PR head moves between `autoMerge`'s two `gh pr view` calls, the old `<ID>.merge` stays until the next poll clears it.
- **`<ID>.pr` is never refreshed with `autoMerge: off`.** An In Review ticket looks up its PR only while `<ID>.pr` is missing, so a replaced PR keeps showing the old link.
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
- **No review feedback:** PR review comments are not fed back into the session yet (see improvements.md, item 2).

## Accepted trade-offs

- A row's PR appears only after the next poll finds it (`<ID>.pr`), not the moment the agent opens it.
- With `autoMerge: off`, an In Review ticket without a PR costs one `gh pr list` per poll until it has one.
- `aw tail` and `status` read only the last 256 KiB of a transcript.

## Unverified

Never exercised end-to-end: the nono profiles (run the README's first-run checklist on a throwaway repo first), and live Claude, Codex and GitHub runs of the status, PR and auto-merge paths. Also unchecked against live services:

- nono's GitHub credential route for `git push`; whether `gh`'s endpoint rules are wide enough; Remote Control endpoints beyond `claude.ai` from inside the sandbox.
- Linear: `issue(id: "ENG-42")` lookup and filter shape; `project { description content }` (field names checked against the published schema only); whether `repo: owner/name` lines are stored with Markdown escapes (e.g. `my\_repo`, which is then rejected); label names containing `/`.
- `gh repo clone` into a nested path on first use; whether trusting `~/agent-ws` covers worktrees below it; that `gh repo view --json nameWithOwner` reports the new name for a renamed or transferred repo.
- Phase sub-tickets: `gh issue create --parent`, `gh api …/sub_issues`, Linear `children`, Linear `issueCreate` with `parentId`, and that Linear adds no default labels to child issues.
- Codex picking up skills from `~/.codex-aw/skills`.
- Auto-merge: `statusCheckRollup` item shapes (CheckRun `status`/`conclusion`, StatusContext `state`), `mergeable` turning `UNKNOWN` → `MERGEABLE`, and `gh issue close` on an issue `Closes #n` already closed.

## Tests

- `tests/dash.test.ts` drives the dashboard in a real tmux pane, so it fails in sandboxes without tmux or a TTY.
