# tender — agent workflow

Move a GitHub issue or Linear ticket to **ready**, and `tender` starts a Claude Code or Codex session for it: in its own git clone, inside the [nono](https://github.com/nolabs-ai/nono) sandbox, in a tmux window you can attach to. The agent implements the ticket, runs the tests, pushes `agent/<ID>` and opens a PR; `tender` then moves the ticket to **In Review**.

- **Watch and steer locally.** `tmux attach -t tender`, or open its clone in your editor. Codex sessions are interactive, so they also land in the ChatGPT/Codex app history. Claude sessions run without Remote Control: they hold an inference-only token (nono's phantom, or the setup-token without a sandbox), which cannot open Remote Control sessions.
- **Runs where you are.** Directly on your machine (sandboxed by nono), or on a VM (`sandbox: "none"`, the VM is the boundary). Same code, same config.
- **No moving parts to babysit.** A small Bun + TypeScript program, no database: state is the tracker, the tmux windows and the session clones. Polls instead of webhooks, so nothing listens on a port.
- **Your setup, read-only.** Agents use your `CLAUDE.md`, `AGENTS.md` and skills, but run from their own config dirs (a fresh `<ID>.claude` per Claude ticket and `<ID>.codex` per ticket) and cannot modify yours.

## Features

**Picking up work**
- **Sources:** GitHub issues, with labels over the repos you allowlist, or Linear tickets from a team. Several sources can run side by side.
- **Ready means:** the `agent` label plus `host:<host>`, so a laptop and a VM never take the same ticket. One machine can also take unlabelled tickets (`defaultHost`).
- **Which repo, in what order:**
  - Repo allowlist, checked against GitHub renames and redirects.
  - A Linear ticket names its repo with a label or a `repo:` line in the ticket; otherwise its project picks the repo that claims it in `.tender/config.yaml`.
  - Most urgent tickets start first: Linear priority, or a GitHub `priority:*` label.
- **Limits:** at most `maxConcurrent` sessions in total and per repo; optionally no new starts while `maxInReview` tickets wait in review.

**Running agents**
- **Agents:** Claude Code or Codex, chosen per repo.
- **Isolation:** one git clone and branch `agent/<ID>` per ticket, in its own tmux window.
- **Sandbox:** [nono](https://github.com/nolabs-ai/nono), or none on a VM where the VM is the boundary.
- **Your config, read-only:** a fresh agent config dir per ticket. Agents use your `CLAUDE.md`, `AGENTS.md` and skills but cannot change them.
- **Claude login:** the sandbox holds only a phantom token. `tender` refreshes the host login itself before it expires ([Claude auth](#claude-auth)).

**While it works**
- **[Phases](#phases):** a phased plan is mirrored into sub-tickets that track its status.
- **[Questions](#questions):** a blocked agent's question is posted to the ticket, and your reply is delivered back to the session.
- **[Findings](#findings):** problems outside the ticket's scope become new tickets, not drive-by fixes.
- **Stall detection:** a session that writes nothing for `stallMinutes` gets `needs-human` and a comment with its last pane lines.

**After the PR**
- **Ticket status:** moves to In Review once the PR exists, then to [Ready to merge](#ready-to-merge) once the PR is clean and nothing waits on the agent; back to In Review on new commits, a failed check or new feedback.
- **[PR feedback](#pr-feedback):**
  - Review comments, failed checks and merge conflicts are delivered to the live session.
  - After 3 rounds the ticket is parked with `needs-human`.
- **[Auto-merge](#auto-merge):** modes `off`, `all`, `shadow` and `intelligent`. `intelligent` adds gates for critical paths, deleted tests, PR size and the agent's own confidence.
- **Cleanup:**
  - A done ticket ends its session, and its clone is deleted once nothing is unpushed.
  - A canceled ticket ends its session and keeps its clone.
  - A ticket reassigned to someone else is stopped the same way, with one comment.

**Watching**
- `status [--json]`: every session's state, runtime, phases and PR.
- `watch`: a terminal dashboard with a live transcript and attach and open-PR keys ([Watching sessions](#watching-sessions)).
- `tail <ID>`: follow one session's transcript.
- `tmux attach -t tender`: the live terminals, where you can steer an agent directly.

Planned, not built: signal intake (perf regressions, Supabase advisors, slow queries) in [docs/improvements.md](docs/improvements.md#signal-intake).

## How it works

`tender.json` has three parts: `repos`, the allowlist of GitHub repos `tender` may work on (with per-repo settings); `defaults` for those settings; and `sources`, where tickets come from (a GitHub label set over the allowlisted repos, or a Linear team). Every `pollIntervalMs` (default 60 s), for each source:

```
ready ticket ──► resolve its repo; not in `repos`, or GitHub redirects it ──► one comment, skipped
             ──► gh repo clone <owner>/<name> ~/agent-repos/<owner>/<name>.tmp-…, then rename   (first time only)
             ──► git clone --shared <that clone> ~/agent-ws/<owner>/<name>/<ID>, branch agent/<ID> from origin/<base>
             ──► tmux window <owner>/<name>/<ID>: systemd-run --scope … nono run … -- claude … "<prompt>"
             ──► In Progress + assigned to you + comment "tender: picked up on <host>"   (move fails ──► session kept and counted, move retried each poll while its window is open; a failed comment is only logged)
.tender/run/phases.json changed  ──► create / update phase sub-tickets
.tender/run/question.md changed  ──► comment "tender: question from agent: …"; first reply by a feedbackAuthor ──► .tender/run/answer.md + one line via .tender/run/inbox (Claude) or pasted (Codex), once idle
PR for agent/<ID> exists ──► In Review + comment with the PR link
.tender/run/findings.json (PR open) ──► each entry filed once as an unlabelled ticket + one "tender:" comment linking them
in review, autoMerge on   ──► gh pr merge --squash --delete-branch, ticket Done; or one "tender: not auto-merged" comment per head SHA (shadow: "tender: would auto-merge", never merges)
in review, window open   ──► feedbackAuthor PR comments, failed checks, conflicts ──► .tender/run/feedback.md + one line via .tender/run/inbox (Claude) or pasted (Codex), once idle
in review, PR clean, no pane output for 5 min or window gone, nothing to deliver, not auto-merged ──► Ready to merge + comment; new commits, failed check, conflict or new feedback ──► back to In Review + comment
session ended, no PR     ──► one comment "tender: session ended without a PR"
3 feedback rounds used   ──► `needs-human` label + one comment; feedback, auto-merge, start and the ended comment pause until a human removes it
`working`, quiet 30 min  ──► `needs-human` label + one comment with the last pane lines; the session keeps running
ticket done / closed     ──► kill session; nothing uncommitted or unpushed ──► delete the session clone
ticket canceled          ──► kill session, keep the session clone and its files until the ticket is done
reassigned to someone else (in progress / in review) ──► same as canceled + one comment "tender: stopped, reassigned to <x>"
```

- **Canceled** = GitHub: closed as not planned or duplicate, or deleted. Linear: any state of type Canceled or Duplicate, or trashed (a deleted or trashed ticket is never done, so delete its clone by hand). `tender` kills the session (no Ctrl-C first: transcripts are written as they go), writes `<ID>.ended`, logs `stopped`, posts nothing and deletes nothing. The clone and its files stay until the ticket is done (GitHub: reopen and close as completed; Linear: move it to a `done` state), then cleanup runs as usual; or delete them by hand. A canceled ticket is not in the ready listing, so it is never started. Reopened with the in-progress marker still on, it stays stopped and `tender` logs that once per run (as for any ended session still in progress); remove the `in-progress` label (Linear: move it to `Todo`) to start it again in the kept clone.
- **Assignee** = the claim assigns the ticket to the `gh` user (`gh issue edit --add-assignee @me`) or the Linear API key's user (`assigneeId` in the same `issueUpdate`): your own account, no bot. That user is read once per poll per source (`gh api user`, Linear `viewer`), and only when a listed ticket has an assignee. A ready ticket assigned to someone else is skipped, logged once per ticket; unassigned or assigned to you is fine. On GitHub, which allows several assignees, a ticket is someone else's only while you are not among them. An In Progress or In Review ticket now assigned to someone else is stopped like a canceled one (kill session, write `<ID>.ended`, keep the clone and files) and gets one `tender: stopped, reassigned to <x>` comment, also when its session had already ended (recorded in `<ID>.reassigned`, cleared when the ticket starts again; a failed post is retried next poll); `tender` then leaves it alone (no move to In Review, feedback, auto-merge or phases) until it is assigned back to you or unassigned, which then reads as an ended session still in progress. Removing yourself as assignee stops nothing.

- **Ready** = GitHub: open + `agent` + `host:<host>` labels, not assigned to someone else. Linear: `Todo` state + the same two labels, same assignee rule.
- The `host:<host>` label decides which machine takes a ticket, so a laptop and a VM never pick up the same one. With `"defaultHost": true` this machine also takes tickets with no `host:` label at all, so on a single laptop you only need `agent`. Set it on one machine only: claiming is not atomic, so two default hosts can both start the same unlabelled ticket.
- The `agent` label is never removed, as a permanent record. On GitHub a ticket is skipped while it has `in-progress`, `in-review` or `ready-to-merge`; to re-run one, close its old PR and remove that label.
- **Parked** = the `needs-human` label, matched case-insensitively (Linear: an ungrouped team or workspace label, not a state; `tender` does not create it). `tender` adds it when it hands a ticket to a human (the PR feedback limit, or a stall) and never removes it. While it is there `tender` does not start the ticket, deliver PR feedback, check for stalls, file findings, auto-merge, move it to or from Ready to merge, or post "session ended without a PR"; questions, answers, phases, the move to In Review, the merged-by-hand recovery (see [Auto-merge](#auto-merge)), cleanup of a done ticket and the stop of a canceled or reassigned one still run; the label never kills a window or deletes anything. Remove the label to resume. A human may add it by hand too. These checks use the poll's listing, except the two hard to undo, which re-read the label first and treat a failed read as parked: an actual merge, and restarting the feedback rounds. The label is a workflow signal, not a security boundary: the agent's GitHub token can edit labels.
- **Stalled** = a session with a tmux window whose own state is `working` (Claude's session record, or the Codex hook, without the 10-minute `unknown` downgrade of `tender status`) and whose transcript, or launcher if it has none, was last written `stallMinutes` (default 30) ago or more. A long build is just as quiet, so set it above your slowest test run. Transcript writes are the signal, not tmux activity, since the agent's spinner redraws the pane while it is busy. `tender` parks the ticket and posts one comment with the last lines of the session's own pane (the pane started by the ticket's launcher script, found by `#{pane_start_command}` so splits and swaps never redirect it; none while it is in copy mode; `tmux capture-pane -p -S -20`, escapes and controls stripped, capped at 1500 chars, fenced); it never kills the window or touches the worktree. `<ID>.stall` records the activity time it reported, so removing the label does not repeat the comment for the same stall; new transcript activity and then another quiet `stallMinutes` comments again. It is written after the comment, so a failed comment is retried once the label is removed. A stall parks the ticket before feedback and auto-merge run in the same poll. Checked each poll for In Progress and In Review tickets that are not parked.
- Ready tickets from all sources are started most urgent first: Linear's priority (Urgent, High, Medium, Low), or on GitHub an optional label `priority:urgent|high|medium|low` (case-insensitive; the most urgent wins if several). No priority goes last; ties keep source order from `tender.json`, then tracker order. `scripts/setup.sh` does not create the `priority:*` labels.
- At most `maxConcurrent` sessions in total, and at most `repos[].maxConcurrent` per repo. With `maxInReview` set (host-wide, or `repos[].maxInReview` per repo), no ticket starts while this host's In Review plus Ready to merge tickets reach it; each poll lists them once per source before starting anything (a failed repo or lookup, a listing that fills its 100-issue page, or a Linear project map that cannot be read, starts nothing that poll; a ticket no repo claims counts toward the host-wide limit only) and writes the counts to `<workspaceRoot>/.in-review` for `status` and `watch`. Unset means no limit and no extra listing. Ticket text only ever goes into the prompt file, never into a shell command.

### Which repo a ticket goes to

- **GitHub:** the issue's own repo. A source polls every repo in `repos`.
- **Linear:** the first of: a ticket label `repo:owner/name`; a line `repo: owner/name` in the ticket description (first such line, at the start of a line); the allowlisted repo whose `.tender/config.yaml` claims the ticket's project (`tracker.linear.project`). The project's own text and labels are not read. A project matches by name (case-insensitive), and also the repo it last resolved to while that repo's claim is unchanged, so renaming it in Linear keeps its repo until `tender` restarts. A project claimed by two repos (by name, or by name and that earlier match) is ambiguous: it is logged once and its tickets need a label or description line. `team` does not affect routing; a match from another team's source is logged once. The map is built from every allowlisted repo's config on its base branch (cloned if missing, fetched once per poll), only when a listed ticket has no label or line. A repo GitHub now resolves to another name, with no clone yet, claims nothing. While any other repo's config cannot be read or is invalid, tickets that rely on their project wait, logged each poll, with no comment. A ticket that names no repo gets one comment and is skipped.
- The result must match a `name` in `repos` (case-insensitive; the configured spelling is then used everywhere). Otherwise the ticket gets a comment (`tender: repo x is not in the tender allowlist`, `tender: no repo set on this ticket`, or `tender: … is not a valid owner/name`) and is skipped, with no worktree. Repo strings from tickets must match `owner/name` of `[A-Za-z0-9_.-]`, owner not starting with `-` or `.`, no `..`, name not `.` and not ending in `.git`, and only reach `gh`/`git` as argv.
- GitHub serves a renamed or transferred repo under its old name (asking for `zeit/next.js` returns `vercel/next.js`). So before listing a repo's issues, and before cloning or starting any ticket, `tender` checks `gh repo view <repo> --json nameWithOwner` equals the allowlisted name (case-insensitive). The check before listing is cached for 5 minutes; the one right before cloning or starting a ticket is never cached. On a mismatch the repo is skipped and logged, and a Linear ticket for it gets the rejection comment; a failed lookup skips the repo (or the start) for that poll, without a comment. A failed `gh issue list` likewise skips only that repo for that listing and is logged; the tickets that listing would have returned are not started or reconciled that poll, but are never treated as closed or ended (cleanup asks each ticket's state, and limits count tmux windows).
- Only Linear tickets are rejected (a GitHub ticket's repo is allowlisted by construction; a redirected one is only logged). A Linear ticket gets at most one rejection comment ever, whatever the reason and from however many sources, recorded in `<workspaceRoot>/.rejected/<ID>` before the comment is posted: a crash in between loses the comment rather than repeating it, and a failed post clears the record so the next poll retries. Starting the ticket later does not clear it.
- Each worktree has a `<ID>.source` file next to it, outside the sandbox, naming the source that started it. Only that source acts on the worktree (cleanup, in-progress and in-review checks, phases, "ended without a PR"); others ignore it. If that source is no longer in `tender.json`, the worktree is left alone and logged once per run. Nothing inside the worktree is trusted for this. A ready ticket whose `<ID>.source` names another source (configured or not) is skipped and logged; only the owner restarts it. A Linear ticket keeps the repo it was started in even if its label or description changes later; while it has a window, or a worktree or `.source` in any `<workspaceRoot>/<owner>/<name>`, it is not started in another, also when that repo has since been removed from `repos` (its worktree is then left alone).

### Phases

The default prompt has the agent plan as instructed by `planStep` (default: "Plan and implement the ticket."). It forbids any attribution (`Co-Authored-By`, "Generated with ...", emoji signatures) in commits, PR titles/bodies and ticket comments. When it splits the work into phases it writes them to `.tender/run/phases.json` in its worktree (git-ignored via `.tender/run/.gitignore`): an array of `{ key, title, body, status }`, status `todo` → `in-progress` → `done`. The agent never talks to the tracker; on every poll, for each of its in-progress and in-review tickets, `tender` mirrors the file:

- a new `key` → a sub-ticket of the parent titled `<ID>: <title>`, with no labels (GitHub: `gh issue create --parent`; Linear: child issue in `Todo`, same team);
- `in-progress` → the `in-progress` label / `In Progress` state;
- `done` → shown as in-progress while the parent is In Progress; closed / first `done` state once the PR exists, just before the parent moves to In Review. Closing children mid-session could trip Linear's team setting "auto-close parent when all sub-issues are done" and `tender` would then clean up the running session.

Phases are history, not a gate: the same session works the ticket to the PR, and the parent's lifecycle is unchanged. Sub-tickets lack the `agent` label, so they are never picked up as work, `defaultHost` included. Created refs and synced statuses live in `<workspaceRoot>/<owner>/<name>/<ID>.phases.json`, outside the sandbox, written atomically. Before creating a sub-ticket `tender` lists the parent's existing ones and adopts one with the same `<ID>: <title>` that it has no record of, so a crash or lost response between creating and recording doesn't duplicate it. Tickets in review keep syncing every poll, so a failed final sync is retried. The file is untrusted: max 64 KiB and 20 phases, `key` `[a-z0-9-]{1,40}` starting with a letter or digit, one-line title ≤ 120, body ≤ 4000; `.tender/run` and the file are opened without following symlinks (the directory is pinned by fd via `/proc`, so Linux only) and anything but a regular file is rejected. An invalid file is logged and skipped for that poll, and a status moving back is ignored. Cleanup leaves sub-tickets as they are.

### Findings

The prompt forbids fixing, or leaving TODO comments for, problems outside the ticket's scope. The agent lists them in `.tender/run/findings.json` instead: an array of at most 5 `{ title, body }`, read like `phases.json` (max 64 KiB, no symlinks, regular file only; a wrong shape is logged and skipped for that poll). Once the PR exists, `tender` files each entry as a new ticket in the same repo (GitHub: `gh issue create`, no labels, no parent) or team (Linear: `Todo`, no labels, no parent), then posts one `tender:` comment on the source ticket linking the batch. It runs at the move to In Review and every poll while In Review, so entries added while addressing feedback are filed too. The ticket comment, not the PR, carries the links: it works for both trackers and stays after the PR is merged. Filed tickets lack the `agent` label, so they are never picked up as work; a human triages them. Title and body are untrusted: control and escape characters are stripped, the title is one line capped at 120 chars, the body at 4000, every `@name` gets a zero-width space after the `@`, and any word that resolves to a `linear.app` host (also percent-encoded, fullwidth or with invisible characters) is replaced by `[linear[.]app link removed]` (Linear turns profile URLs into mentions), so filing pings no one. Each body ends with a line saying it was filed from the agent session on `<ID>`. `<ID>.findings`, next to the worktree, records each entry's hash just before its create and is never rolled back: a crash or failed create loses that finding (the comment lists it as not confirmed filed), never files it twice. It also keeps each created ticket's URL until the linking comment posts, so a failed comment, or a crash before it, is retried every poll. The comment ends with a `tender-findings <hash prefixes>` line; a retry first reads the ticket's comments and skips entries already listed there, so a comment whose response was lost is not posted twice (a failed or incomplete read defers to the next poll; any `tender:` comment with that line counts, so a forged one can suppress the links). The sidecar is read like `phases.json` (max 16 KiB, no symlinks) and validated (hash format, title length, URL on the ticket's own host in issue shape); anything off fails closed: nothing is filed or posted for that ticket, and titles are re-sanitized when posted. At most 5 are filed per ticket over the whole session, whatever the file says later. Skipped while parked; a ticket merged while parked never files its findings.

### Questions

Every comment `tender` posts starts with `tender:`. A blocked agent writes `.tender/run/question.md` (the default prompt asks for what blocks it, the options and the one it recommends; Markdown, ≤ 8000 chars after trimming, no control characters but newline and tab, read like `phases.json`) and stops. While the ticket is in progress with no PR and its window open, each poll `tender` hashes the file and, when it changed (or the same question is still there after its answer was recorded), records `{hash, postedAt}` in `<ID>.question` before commenting `tender: question from agent:` and the text (a crash or failed post loses the question, never doubles it; an invalid file is logged and not posted).

The answer is the first comment created after `postedAt` whose author is in the repo's `feedbackAuthors` (GitHub login or Linear user email, case-insensitive) and whose body does not start with `tender:` (tender posts with your credentials). Later comments and edits are ignored. Empty `feedbackAuthors` (default): questions are posted, answers never delivered. Once the session is `idle` (see [Live state](#live-state); `waiting` may be a permission prompt) and its tmux window exists, `tender` records the answer's id in the sidecar, writes `.tender/run/answer.md` as `<answer from="<author>" ticket="<ID>">…</answer>` (truncated to 8000 chars), sends the session `Your question was answered by the operator: read .tender/run/answer.md`, and removes `.tender/run/question.md` if unchanged. Answer text never goes through keystrokes. How the line is sent: when a Claude inbox waiter is running in the session's systemd scope (`pgrep -f --cgroup`, seen from the host), `tender` writes it to `.tender/run/inbox`, and a `Stop` hook passed with `--settings` at launch (`INBOX_HOOK` in `src/agents.ts`) hands it to the session as hook feedback, so it arrives even at an idle prompt and no key is pressed. The hook is `asyncRewake`: each finished turn starts a waiter that polls `.tender/run/inbox` every 2 s and exits 2 with its contents (at most 4 KiB), which wakes Claude; the newest waiter retires older ones, and all of them end with the session. Otherwise (Codex; a Claude session launched before this hook existed; a Claude turn that ended by interrupt or API error, which fire no `Stop`) `tender` pastes the line plus Enter into the pane started by the ticket's launcher script, found by `#{pane_start_command}` so splits and swaps never redirect it (skipped while in copy mode). Each answer is sent at most once; a new question starts a new round. `tender status` / `tender watch` show `question` while a posted question is open, the session is `idle` and there is no PR. Design: [docs/agent-questions.md](docs/agent-questions.md).

### PR feedback

While an In Review or Ready to merge ticket's tmux window exists and its PR is open, each poll `tender` views the PR (one view shared with auto-merge and the [Ready to merge](#ready-to-merge) check; taken again after a capped cursor's label read, and shared back) and collects, since the cursor in `<ID>.feedback`: reviews with text or "changes requested", PR comments and line comments whose author is in `feedbackAuthors` (same rule as answers; empty = no comments are read); failed checks, once per head SHA (the last 10 reported are remembered) and only when none is pending, with the last 80 lines of `gh run view <run> --log-failed` (streamed through `tail`) for up to 3 Actions runs; and `mergeStateStatus` `DIRTY`, once per head SHA, as "rebase on origin/<base> and resolve the conflicts". It waits while the newest comment is under 2 minutes old, so a review still being written is sent as one. Then, once the session is `idle`, it records the cursor, writes `.tender/run/feedback.md` (`<feedback>` with `<comment>`, `<failed-check>`, `<log>`, `<conflict>`; comments truncated to 8000 chars) and sends `There is new feedback on your PR: read .tender/run/feedback.md` the same way as an answer, at most once per round. The ticket stays In Review (moving it back would make the next poll move it forward again and repost the PR link). After 3 rounds, the next batch of feedback parks the ticket with `needs-human` (if adding the label fails, nothing else happens and it is retried next poll), marks the cursor `capped` and gets one `tender: PR feedback stopped after 3 rounds …: a human is needed` comment instead. While parked nothing is read or sent. Once a human removes the label, the rounds start again from 0 (seen comments and reported SHAs are kept), so feedback that arrived meanwhile is delivered as the next round. Upgrading: a ticket capped before the label existed has no label, so it counts as resumed and gets 3 more rounds. A session whose window is gone gets nothing; `tender` still views its PR each poll and logs `<ID>: PR feedback pending but the session's window is gone` once per pending batch (newest comment and head SHA), so a human can restart the session or act on the PR. Nothing is recorded or posted.

### Ready to merge

Each poll, an In Review ticket that is not parked moves to Ready to merge (GitHub: label `ready-to-merge` replaces `in-review`; Linear: the `readyToMerge` state, and without it tickets stay In Review) with one `tender: ready to merge: <PR>` comment when all of these hold: the PR is open and not a draft, every check succeeded, was skipped or neutral (zero checks is fine), it is mergeable, there is no "changes requested" review decision, [PR feedback](#pr-feedback) has nothing left to deliver, the session is done: its tmux window has shown no output for 5 minutes (tmux's own `window_activity`; the [live state](#live-state) never counts, since it comes from files the session writes) or a successful `tmux list-windows` no longer has the window (listed again at the decision, so a slow pass cannot age it; a failed listing, a row that does not parse or an unreadable time moves nothing), and auto-merge did not merge it (`off`, `shadow`, or a gate held it back). It is decided from the PR view auto-merge already does (with `autoMerge` `off`, the same view feedback would do; viewed again if auto-merge waited on a call after it), never from a file the agent writes. `<ID>.ready`, next to the worktree, records the head SHA at the move, written with a ` pending` suffix before it and confirmed after it or by the next listing (a ticket moved there by hand records the head first seen). It goes back to In Review, with one `tender: back in review, <why>: <PR>` comment, when the head moves from that SHA, a check fails, the PR conflicts with its base, a "changes requested" review or new feedback arrives (also feedback still in its 2-minute wait), or the PR is closed (the PR in `<ID>.pr` is viewed when no open one is found) or turned into a draft. A busy session alone does not move it back. A PR merged from Ready to merge, by hand or by auto-merge, moves the ticket to Done exactly as from In Review. `status` shows `ready` in the PR column.

### Auto-merge

`autoMerge` (requested in the repo's [`.tender/config.yaml`](#repo-config), capped by the repo's `autoMerge` in `tender.json`) lets `tender` merge a ticket's PR; the prompt forbids the agent to merge. That is a prompt rule, not a boundary: the sandbox's GitHub token can reach `/repos/**` and `/graphql` (`gh pr create` needs GraphQL, and nono filters only method + path, not the mutation), so a prompt-injected agent can still `gh pr merge` or push to `baseBranch` itself, even with `autoMerge: "off"` or `no-automerge`. The real boundary is GitHub branch protection on `baseBranch` (required PR, required status checks); enable it. On every poll, for each in-review ticket with an open PR on `agent/<ID>`, `tender` reads `gh pr view --json …` and decides:

- `off` (default): never merges.
- `all`: merges when the PR is open, not a draft, from this repo (not a fork), targets `baseBranch`, has no conflicts, no review decision "changes requested", no check failed or pending (zero checks is fine), and neither the PR nor the ticket has the label `no-automerge`.
- `shadow`: decides exactly like `intelligent` but never merges: it posts one `tender: would auto-merge: <reason>` (or `tender: not auto-merged: <reason>`) comment per head SHA and never merges, though the ticket can still move to [Ready to merge](#ready-to-merge). Use it to see what `intelligent` would do before turning it on.
- `intelligent`: the same as `all`, plus gates `tender` computes from the PR itself. Never merged: any changed file whose path, or old path for a rename, matches a critical path; an existing test file that loses lines, is deleted or is renamed (from or to a test path; adding test files or only adding lines to one is fine); or a large change. Size is additions + deletions and changed files: small ≤ 150 lines and ≤ 5 files, medium ≤ 500 and ≤ 15, else large. Small needs nothing more (zero checks is fine). Changed files come from `gh api --paginate repos/<owner>/<name>/pulls/<n>/files` (not `gh pr view --json files`, which lacks a rename's old path and stops at 100 files), fetched only when every other gate would let the PR merge; a list whose length differs from the PR's `changedFiles` holds it back. Medium also needs at least one check that succeeded (skipped or neutral ones don't count), and a valid `.tender/run/merge.json` from the agent with `tested: true`, `confidence: "high"`, `critical: false` and `reviewed: true` (a model of a different family reviewed the final diff; missing or `false` counts like `confidence: "low"` here).

The agent writes `.tender/run/merge.json` (`{ "tested", "confidence": "high|medium|low", "critical", "reviewed", "reviewer"?, "reason" }`, max 4 KiB, read like the phases file: no symlinks, regular file only) just before opening the PR. Ticket text can steer the agent, so the file is untrusted: it can only hold a merge back (`critical: true` or `confidence: "low"` blocks any size; missing or invalid blocks medium), never let one through. Built-in critical paths (case-insensitive globs on the repo-relative path; a pattern without `/` matches the file name at any depth): `.github/**`, `**/Dockerfile*`, `docker-compose*`, `**/migrations/**`, `**/*.sql`, `package.json`, `bun.lock*`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `requirements*.txt`, `**/auth/**`, `**/*secret*`, `**/*.env*`, `**/*.pem`, `**/*.key`, `nono/**`, `tender.json`, `.tender/**`, `**/infra/**`, `**/terraform/**`, `**/deploy/**`, `AGENTS.md`, `CLAUDE.md`, `**/.claude/**`, `**/.codex/**`, `.mcp.json`, `CLAUDE.local.md`, `GEMINI.md`, `**/.gemini/**`, `**/.cursor/**`, `.cursorrules`, `uv.lock`, `poetry.lock`, `Gemfile`, `Gemfile.lock`, `**/*.tf`, `**/k8s/**`, `**/helm/**`, `.npmrc`, `bunfig.toml`, `.gitmodules`, `**/.husky/**`, `.pre-commit-config.yaml`, `Makefile`, and test runner config: `conftest.py`, `pytest.ini`, `jest.config.*`, `vitest.config.*`, `playwright.config.*`. `criticalPaths` in `tender.json` and in the repo add to them; neither can remove any. Built-in test paths (same glob rules): `**/*.test.*`, `**/*.spec.*`, `**/tests/**`, `**/test/**`, `**/__tests__/**`, `**/e2e/**`, `**/spec/**`, `**/test_*.py`, `**/*_test.go`, `**/*_test.py`. The repo's `testPaths` add to them.

Pending checks or unknown mergeability wait silently. A merge is `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>` (never `--admin`), so a push after the decision makes it fail. Right before merging `tender` views the PR again and re-runs every gate; if the head moved, it drops `<ID>.merge` and decides on the new head next poll. A failed merge is logged and retried next poll, and so is a PR not yet `MERGED` after the command (merge queue). After a merge `tender` comments once, closes the GitHub issue / moves the Linear ticket to the first `done` state, and cleanup follows. A PR found merged on a later poll (also by hand) moves the ticket the same way if it is from this repo and targets `baseBranch`, which retries a failed close; this also runs on a parked ticket, which otherwise gets no merge and no comment. A PR that is not merged gets one `tender: not auto-merged: <reason>` comment per head SHA, recorded in `<ID>.merge` next to the worktree; it is re-evaluated every poll, so a re-run check or a removed label still lets it merge without a new commit.

## Quick start

```bash
scripts/setup.sh owner/repo   # config dirs, nono, labels, .env and tender.json from the examples, login check
scripts/run.sh                # preflight (dry run), then poll in the foreground
```

The same are available as `bun run setup owner/repo`, `bun run start`, `bun run once`, `bun run service`, `bun run status`, `bun run watch`, `bun run dry`, `bun run test` and `bun run typecheck` (`tsc --noEmit`; run `bun install` once for `@opentui/core`, the `watch` dashboard's only runtime dependency, and the dev-only `typescript` and `bun-types`; if it cannot be loaded `watch` falls back to plain output, and nothing else needs it). Edit `repos` and `sources` in `tender.json` before running, and add a [`.tender/config.yaml`](#repo-config) to each repo (optional; `bun tender.ts check <repo>` validates it). `scripts/run.sh once` does a single pass; `scripts/run.sh service` installs and starts the systemd user unit. `run` and `once` hold a kernel lock on `<workspaceRoot>/.lock` while they live, so a second one on the same workspace exits with an error (`--dry-run`, `status`, `watch` and `tail` take no lock). The agent logins below are interactive; `scripts/setup.sh` prints what is still missing.

## Setup

### 1. Requirements

Linux. On `PATH`: `bun`, `git`, `gh` (logged in: `gh auth status`), `tmux`, GNU `timeout` (coreutils; bounds every command `tender` runs), a systemd user manager (`systemd-run --user`, `systemctl --user`; each session runs in its own scope), `pgrep` (procps), and `claude` and/or `codex`. A skill named in `planStep` must be installed globally in `~/.claude/skills` (`scripts/setup.sh` links that dir into both agent config dirs). For sandboxed repos, install nono:

```bash
curl -fsSL https://nono.sh/install.sh | sh
```

### 2. Agent config dirs and logins

```bash
scripts/setup.sh owner/repo
```

Idempotent, never overwrites real files. It creates `~/.claude-tender` and `~/.codex-tender` (symlinking your `CLAUDE.md`, `AGENTS.md`, skills), creates `~/agent-ws` and `~/agent-repos`, and creates the labels for each repo you pass. Then check the logins.

#### Claude auth

Sandboxed (`nono`) sessions use your own Claude login in `~/.claude` (`claude auth login` if you have none); there is nothing to set up for them. The session holds only nono's phantom in `CLAUDE_CODE_OAUTH_TOKEN`. For each request to `api.anthropic.com`, nono's proxy swaps in the real access token, read on the host from `~/.claude/.credentials.json` by tender's own `bun` (`TENDER_BUN`), from `/`, under `env -i`, uncached. The session never sees the token or the file. Each session keeps the `TENDER_BUN` path it was launched with, so restart running sessions if that bun is removed (e.g. a mise-managed bun on upgrade). Codex sessions get the same route and their own `<ID>.claude` dir, so a `claude` they run works too.

Claude refreshes only inside the last 5 minutes of the access token's 8 hours, and never from an env token, so `tender run` refreshes your login itself: at start and every 60 s it checks the expiry, and inside that window runs `claude -p /cost` on the host (the real executable that `mise which claude` resolves to, not the mise wrapper, with a clean env, `--safe-mode`, no setting sources and tender's dir as cwd). That makes no model turn, and Claude's own lock keeps it from racing your interactive sessions. `tender once` checks once; `--dry-run`, `status`, `watch` and `tail` never refresh. If `tender` is down for longer than the token has left, sessions get 503s from nono's proxy (Claude reports a server-side error) until your own Claude use or `tender` refreshes it. When the login itself reaches its time limit, run `claude auth login`; `tender` warns 3 days ahead, and a sandboxed Claude start fails once it has passed.

Unsandboxed (`none`) Claude sessions authenticate with a long-lived token instead:

```bash
claude setup-token   # prints the token; save it with:
install -m 600 /dev/stdin ~/.claude-tender/oauth-token   # paste, then Ctrl-D
```

The launch script reads it on the host and passes it as `CLAUDE_CODE_OAUTH_TOKEN`, so it never lands in the script, the prompt or the logs. An unsandboxed Claude start fails while the file is missing. Copying `.credentials.json` per ticket would not work: Claude rotates refresh tokens, so the copies would log each other out.

Log Codex in; this login is separate from your own:

```bash
CODEX_HOME=~/.codex-tender codex login
```

#### Codex auth

Codex uses that ChatGPT login, so sessions draw on your plan's Codex limits (Plus, Pro, Business or Enterprise), shared by all concurrent sessions. Each ticket gets its own `CODEX_HOME`, `<workspaceRoot>/<owner>/<name>/<ID>.codex`, recreated at every start from the `~/.codex-tender` template: a copy of `config.toml` (and `hooks.json`) with `[projects."<session clone>"] trust_level = "trusted"` appended unless already there, so Codex starts without its folder-trust prompt (a template it would make invalid TOML, e.g. an inline `projects` table, fails the start), `AGENTS.md` and `skills` linked to their resolved targets, and `auth.json` (0600). Sessions cannot read or write the template, so a session cannot plant config, MCP servers, hooks, instructions or transcripts for other tickets.

Only the host holds the refresh token. ChatGPT refresh tokens rotate and Codex rejects a reused one, so a copy that could refresh would log the template out. The ticket's `auth.json` holds only what an access-token login needs, copied from the template: `auth_mode`, `last_refresh` and the tokens' `id_token`, `access_token`, `account_id`, `login_owner_id` and `oauth_provenance`, with `refresh_token` set to `""` (Codex refuses the file without the key). Anything else in the template (an API key, a personal access token, Bedrock keys, fields a newer Codex adds) stays on the host. It carries the access token, which lives 10 days and which the session can read: its own credential, like the Claude token. Before copying, if the template's access token (its JWT `exp`) expires within 24 hours, `tender` refreshes it on the host: Codex has no refresh command, so `tender` runs `CODEX_HOME=~/.codex-tender codex app-server` and sends `account/read` with `refreshToken: true` (the app-server's forced refresh), waiting for the reply before closing it, under `flock` on `~/.codex-tender` so two `tender` processes never refresh at once. A refresh killed at its 60 s deadline after the server rotated the token but before Codex saved it loses the template login; log in again. If the token still expires within 24 hours afterwards, or the template has no ChatGPT login, the start fails with the fix (`CODEX_HOME=~/.codex-tender codex login`) in the log. A Claude start never fails over it; its Codex is then just not logged in. So a session starts with at least a day of token. If it runs past expiry, Codex tries to refresh with the empty token, which fails, and its requests fail with "Your access token could not be refreshed…": the session stays open but cannot work, and likely reads as idle rather than stalled (from the Codex source; not checked live). Restart the ticket for a fresh copy.

No trust step: Claude keys folder trust on the git repository root ([docs](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust)), here the session's own clone, so trusting `~/agent-ws` or your home does not cover it. Each Claude ticket gets its own config dir, `<workspaceRoot>/<owner>/<name>/<ID>.claude`, which `tender` recreates at every start: symlinks to the template's `settings.json`, `CLAUDE.md`, `AGENTS.md`, `skills` and `plugins` (resolved, so they point at the real files), and a `.claude.json` holding only your login's onboarding and account keys (from `~/.claude.json`) plus `projects["<session clone>"].hasTrustDialogAccepted` (the documented way to trust a folder by hand), so the session starts without the dialog. `~/.claude-tender` is the template: sessions can write only their own dir and read only the template's `settings.json` and `plugins/`, so a session cannot plant hooks, instructions, MCP servers or plugins for other tickets. Anything it leaves in its own dir is gone at the next start and at cleanup.

Check the sandbox profiles parse:

```bash
nono profile validate nono/tender-claude.json
```

```bash
nono profile validate nono/tender-codex.json
```

```bash
nono profile validate nono/tender-check.json
```

### 3. Tracker

**GitHub:** create the labels in each repo (`scripts/setup.sh` prints these with your host name):

```bash
for l in agent in-progress in-review ready-to-merge needs-human "host:$(hostname -s)"; do gh label create "$l" --repo owner/repo --force; done
```

**Linear:** create the labels `agent`, `needs-human` and `host:<host>` in the team (`needs-human` may be a workspace label; `tender` does not create it and parking fails with an error naming it when it is missing), make sure it has `Todo`, `In Progress`, `In Review`, `Done` states (or set your names in the config) and, for [Ready to merge](#ready-to-merge), a state named in `readyToMerge`, and put a personal API key in `.env` (gitignored, loaded by Bun from the working directory):

```bash
cp .env.example .env
```

A Linear ticket names its GitHub repo with a label `repo:owner/name` or a line `repo: owner/name` in its description; otherwise its project picks the repo whose `.tender/config.yaml` has `tracker: { linear: { project: "<name>" } }`. With none, it is skipped with one comment (see [Which repo a ticket goes to](#which-repo-a-ticket-goes-to)).

### 4. Config

```bash
cp tender.example.json tender.json
```

Set `host` to the name in your `host:` label, list every repo `tender` may work on under `repos` (a plain `"owner/name"` takes the `defaults`; `{ "name": "owner/name", … }` overrides them), and add one source per GitHub label set / Linear team. `tender.json` is gitignored. See [Config reference](#config-reference).

`tender` clones each repo into `<reposRoot>/<owner>/<name>` (default `~/agent-repos`) with `gh repo clone` when `run` or `once` starts (a failed clone is logged and retried before the repo's next ticket), into `<path>.tmp-…` and renamed when done, so an interrupted clone is never used. Every command `tender` runs has a 60 s deadline (`timeout -k 5`, whole process group), so a hung `gh`, `git` or `tmux` fails that step instead of stalling polling; `gh repo clone`, the `git fetch` of `origin/<base>` before a start, the session clone and its checkout get 15 min, and so does deleting a session clone. The same fetch before merge decisions or Linear project routing runs every poll, so it keeps the 60 s. If `path` exists but is not the top of its own clone (`git rev-parse --git-common-dir` is not `<path>/.git`: an interrupted clone, or a subdirectory or linked worktree of another clone), or resolves to the same directory as another repo's `path`, the ticket is not claimed and the error is logged; `tender` never deletes it, so fix or remove it (and any stale `.tmp-…` sibling) by hand. Leave the clone there, or point `repos[].path` at another clone that is also used only by `tender`. Never point it at your working clone. Only `tender` writes it: it fetches `origin/<base>` there before each start.

Each session works in its own clone, `<workspaceRoot>/<owner>/<name>/<ID>`, made by `git clone --shared --revision refs/remotes/origin/<base>` from that base clone: it borrows the base's objects through `.git/objects/info/alternates` instead of copying them, so it is cheap at any repo size. `tender` then points its `origin` at the base's own remote URL (so `git push` and `gh pr create` work as before), sets the usual fetch refspec with `tagOpt=--no-tags` (so a fetch brings in no tags) and `origin/<base>`, and creates `agent/<ID>`, all in `<ID>.tmp`, renamed to `<ID>` only when complete (a failed step deletes it); if the base still has an `agent/<ID>` branch from an older worktree session, the new branch starts there. A borrowed object must never disappear from the base, so `tender` never prunes it (its git calls pass `maintenance.auto=false`) and sets `gc.pruneExpire=never` in the base's config, which keeps a manual `git gc` there from deleting objects too (`git gc --prune=now` and `git prune --expire=now` still do, so never run them there). `--local` with hardlinks was rejected because the session could write through a hardlinked object file into the base, and `--no-hardlinks` copies every object per session. Under nono the session can write only its own clone (whose `.git`, config and hooks included, nothing else uses) and read only the base's `.git/objects`; the base's refs, config, hooks and every other session are out of reach. `git push -u` records the upstream, since the session's config is its own. `tender` never runs git inside a session clone on the host once the session has started, because its config, hooks and filters are agent-controlled. At cleanup it runs `git status --porcelain --ignore-submodules=none`, `git log --branches --not --remotes` and `git for-each-ref refs/tags refs/stash refs/notes` under nono with `nono/tender-check.json`: read-only on the clone and the base's objects, no network and no credentials, so a filter or config the session planted runs with neither, and deletes the clone with `rm -rf --one-file-system`, which removes symlinks without following them, only if all three print nothing and exit 0: a done ticket with uncommitted, untracked or unpushed work, or any tag, stash or note (a fresh clone has none), keeps its clone, which is logged and retried every poll until you push or delete it. The session can make its own check print nothing, which then deletes its clone. With `sandbox: "none"` the same checks run unsandboxed, since that agent runs unsandboxed anyway. Like every command `tender` runs, the checks have a 60 s deadline (`timeout -k 5`, which kills the whole process group), so a planted filter that never returns cannot stall polling; on a timeout the clone is kept. A dir whose `.git` is not a directory is kept and logged.

`tender`'s own `git` calls also pass `-c` overrides (`core.hooksPath`, `core.fsmonitor`, `core.alternateRefsCommand`, `maintenance.auto`, and the `ext`, `file` and `git://` transports) as a second layer; only the local copy that creates a session clone re-allows `file`. Because of the `file` override, the clone's `origin` must be an HTTPS or SSH URL; a clone of a local path fails at `git fetch` (`transport 'file' not allowed`).

Unix sockets: Landlock's file rules do not cover `connect()` to a socket, so both profiles set `linux.af_unix_mediation: "pathname"`. Without it, a session could reach your tmux server (`tmux new-window <cmd>` runs on the host), the systemd user manager, D-Bus, gpg/ssh agents, Hyprland and other Claude sessions under `$XDG_RUNTIME_DIR/cc-socks`. The profiles add no host sockets; nono's inherited `default` profile allows connecting to the systemd userdb sockets in `/run/systemd/userdb` (`io.systemd.Multiplexer`, `DropIn`, `NameServiceSwitch`, `DynamicUser`), which answer user and group lookups. The launcher adds `--allow-unix-socket-subtree-bind` for the clone and for the session's temp dir (below), so a session can bind and connect sockets only there; sockets elsewhere (`/tmp` included) and in the abstract namespace fail with `EACCES`. `gh` cannot read `~/.config/gh` in the sandbox and exits if it cannot load its config, so the launcher sets `GH_CONFIG_DIR=<clone>.gh`, a path that never exists: `gh` runs on its defaults with nono's `GH_TOKEN`, and your `gh` config (aliases, `git_protocol`, extensions) does not apply in sessions. gh, git and the GitHub credentials go through nono's TCP proxy, and Codex runs with `--no-daemon`, so neither needs a socket. Claude's inter-session messaging socket (`cc-socks/<pid>.sock`) is denied, and sessions run without it.

Terminals: both profiles exclude nono's `system_read_linux_core` and `system_write_linux` groups, which grant `/dev/pts`, and re-add their other paths. A session reaches its terminal through `/dev/tty` and the pty nono gives it, but cannot open any other `/dev/pts/N`, so it cannot read what you type in another pane or shell, or write escape sequences into it. `/dev/ptmx` is denied too, so a session cannot allocate a pty of its own: Codex's `exec_command` with `tty: true` fails, and plain (pipe) commands, which Claude Code and Codex use by default, are unaffected.

Temp dir: each session gets its own `<ID>.tmpdir` next to its clone, emptied and recreated (mode 700) by `tender` on the host at every start and deleted at cleanup. The launcher exports it as `TMPDIR`, `TMP`, `TEMP` and Claude's `CLAUDE_CODE_TMPDIR`, so `mktemp`, `os.tmpdir()`, Python's `tempfile` and tools that follow them, socket-creating test suites included, land there. Under nono it also holds the session's `XDG_CACHE_HOME`, `<ID>.tmpdir/cache`, so Claude's cache and logs (`claude-cli-nodejs`) and other tools' caches are per session: no profile grants your `~/.cache`, which your own Claude Code also uses. It is a sidecar rather than a dir in the clone so temp files never show in `git status` or block cleanup. Both profiles exclude nono's `system_write_linux` group, the only one granting `/tmp`, and re-grant its `/dev` and `/proc/self/fd` entries except `/dev/pts`, so a session can no longer write the `/tmp` it shared with your host and other sessions; a tool that hardcodes `/tmp` fails (reading there was already denied). A Unix socket path is at most 107 bytes: with `~/agent-ws/nejcm/agent-workflow` and an ID like `ENG-12345` the temp dir is 57 bytes, which leaves 50 for the socket's own path, so a long `workspaceRoot`, owner or repo name can make a test suite's socket fail with `AF_UNIX path too long`; keep `workspaceRoot` short.

Stopping: the launcher runs each session in its own systemd user scope, `tender-<hash>:<owner>:<name>:<ID>.scope`, where `<hash>` is the first 8 hex chars of the SHA-256 of `workspaceRoot` (`systemd-run --user --scope --collect`, with or without nono), because `tmux kill-window` only hangs up the pane: a session that ignores `SIGHUP` or `setsid`s a child keeps running, with its credentials and network. Every stop (done, canceled, reassigned) first runs `systemctl --user kill --signal=KILL` on that scope, which kills every process in it, then kills the window; a scope that is gone is fine. A start kills any scope left under the ticket's name first, and fails (logged, ticket not claimed, retried next poll) if the user manager cannot be reached, so `tender` never starts a session it could not stop. Each pass, before any start, also kills every scope of this workspace that holds none of its tmux session's pane processes (an orphan, whatever its ticket's state; renaming a window does not count), and kills nothing if the panes cannot be listed. The sandbox cannot reach the user manager's sockets, so a session cannot leave its scope. `systemctl --user list-units 'tender-*'` lists them; a session started before scopes existed has none and is stopped by kill-window alone.

### 5. First run

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

### 6. Run continuously

Foreground:

```bash
bun tender.ts run
```

Or as a systemd user service (edit `WorkingDirectory` (it points at `~/Work/agent-workflow`) and `PATH` in the unit first; the unit's `WorkingDirectory` holds the `.env`):

```bash
cp systemd/tender.service ~/.config/systemd/user/ && systemctl --user enable --now tender
```

`KillMode=process` keeps agent sessions alive when the service restarts. `bun tender.ts status` lists sources, repos (with their `autoMerge` and `maxInReview`), a line when a `maxInReview` is reached, and one row per worktree; see [Watching sessions](#watching-sessions).

### Watching sessions

![tender watch: ticket list with phase progress bars, selected ticket detail and live transcript](docs/dashboard.png)

Claude Code and Codex can't import a session while it runs, so observe it instead of resuming it:

- `tmux attach -t tender`: the live terminals, one window per ticket (`owner/name/ID`). Detach with `Ctrl-b d`; typing there steers the agent.
- `bun tender.ts status [--json]`: per worktree its agent, session (`running`: tmux window and no `<ID>.ended`; `ended`; `orphan`: neither), live state (see [Live state](#live-state)), runtime (since `<ID>.sh` was written; JSON `startedAt`, ms epoch), idle (since the transcript was last written), phases `done/total` (`.tender/run/phases.json`, else the `<ID>.phases.json` sidecar; JSON also lists up to 20 as `phases.items` with `key`, `title` and `status`, titled by key from the sidecar) and PR (from `<ID>.pr`, which `tender` writes whenever a poll finds the ticket's PR: in progress, and every poll in review (the auto-merge lookup, or with `autoMerge` `off` its own `gh pr list`), so a replaced PR is picked up; must be a `https://github.com/<owner>/<name>/pull/<n>` URL in a regular file under 512 bytes; `held` when `<ID>.merge` records a "not auto-merged" or, in `shadow`, a "would auto-merge" comment for the current head; `ready` while `<ID>.ready` says `tender` moved it to Ready to merge and the move is confirmed). No network calls.
- `bun tender.ts watch [--interval 2] [--plain]`: a terminal dashboard (OpenTUI), refreshed every `--interval` seconds (default 2, min 1); see below. `--plain`, or stdin/stdout not a TTY, redraws the `status` output instead until `Ctrl-C`; if OpenTUI cannot start, or `@opentui/core` is not in a `node_modules` above `src/`, it prints one line to stderr and does the same (that check assumes Bun's default auto-install, which only downloads when no `node_modules` exists; `install.auto = "force"` in a bunfig still fetches).
- `bun tender.ts tail <ID | owner/repo/ID> [-n 20] [--no-follow]`: read-only, one line per assistant message, tool call (name, cut to 6 columns with `…`, and a short argument) or tool error from the newest transcript (last 256 KiB), then follows it, switching (with a new `#` header) to a newer one when the session starts another (restart, `/clear`). Claude's are `<ID>.claude/projects/<cwd, non-alphanumerics as ->/*.jsonl`; Codex's are `<ID>.codex/sessions/**/*.jsonl`; both are matched by the `cwd` they record, and symlinks and non-regular files are skipped. An ID with transcripts in several repos is refused; name the repo. Tool output is never printed; text is capped and stripped of control and escape characters. Works for a finished ticket whose worktree is gone, as long as its transcript is (it goes with the ticket's `<ID>.claude` or `<ID>.codex` at cleanup or restart).

The dashboard has a header (host, a count per state: `◆ waiting` highlighted since it needs you, `◇ question` when any, `● working`, `○ idle`, `◌ orphan`, `✕ ended`, plus `? unknown` when any; the `maxInReview` line while a limit is reached, kept ahead of the host and clock on narrow terminals; last refresh), a footer with the keys that apply right now and transient messages, and between them:

- On a terminal at least 110 columns wide, the ticket list on the left and the selected ticket on the right. Each ticket is a card: state glyph, ID, repo, agent, then a phase progress bar with `done/total`, idle and runtime (one line per ticket when the list is short on rows). Waiting tickets sort first, then question, working, idle, unknown, orphan, ended, by ID within each; the selection follows the ticket across refreshes. The right side shows the ticket's title row (agent, state and what it is waiting for), runtime, idle, start time, PR (`held` when not auto-merged, `ready` when Ready to merge), branch and worktree, its phases (one bar segment per phase, then a checklist; `+N more` when they don't fit) and below, the live `tail` of its transcript, read incrementally and only for that ticket (wrapped under the message column).
- Narrower terminals stack the list (one line per ticket), the detail and the transcript; below 50 columns or 14 rows only the list and the transcript's last lines are shown.

Colours are truecolor; `NO_COLOR` (set and non-empty) switches to bold, dim and reverse only. Keys:

| key | |
|---|---|
| `j`/`k`, `↓`/`↑` | select; scroll the transcript while it has focus |
| `g` / `G` | first / last; top / follow while the transcript has focus |
| `Tab` | move focus between the list and the transcript (the focused pane has the bright border) |
| `Enter` | maximise the transcript, again to go back |
| `Esc` | close help, or leave the maximised transcript |
| `a` | show the ticket's tmux window: outside tmux the dashboard suspends and runs `tmux attach` (detach with `Ctrl-b d` to come back); inside tmux it runs `tmux switch-client` so your client switches to the `tender` session without nesting (switch back with `Ctrl-b (`/`)` or `L`). Needs a `running` window. |
| `o` | open the PR with `xdg-open` (only `https://github.com/<owner>/<repo>/pull/<n>` links) |
| `r` | refresh now |
| `?` | key help overlay |
| `q`, `Ctrl-C` | quit; the terminal is restored on every exit (also `SIGTERM`, `SIGHUP`, crashes) |

Everything shown is stripped of control, escape, bidi and invisible characters (zero-width joiner and non-joiner are kept for emoji and Persian/Indic text) and cut to the column width. Codex rows show `unknown` without tender's hooks in the template (see [Live state](#live-state)).

### Live state

`state` (`working`, `waiting`, `idle`, `question`, `ended`, `unknown`; JSON also has `waitingFor` and `stateSince`, ms epoch or `null`). An `ended` or `orphan` session is `ended` in JSON; the table and dashboard show an `orphan` session (no tmux window, no `<ID>.ended`) as `orphan`. Otherwise:

- Claude: the session records `claude agents` reads, `<ID>.claude/sessions/<pid>.json`, once per refresh for each Claude ticket with a tmux window. `tender` reads them itself, never running `claude` against a dir the session can write: no symlinks, regular files under 64 KiB, and only records whose pid is still running with the recorded start time. `busy` is `working`, `waiting` carries `waitingFor`. The session must report the worktree path as its exact `cwd`. The format is undocumented (checked on 2.1.323): if it changes, Claude rows show `unknown`.
- Codex: hooks installed by `scripts/setup.sh` (via `scripts/codex-hooks.sh`, a marked block in `~/.codex-tender/config.toml`; the rest of the file is left alone, and the script refuses damaged markers or a result that is not valid TOML; a Codex start whose template lacks the markers logs the fix and still starts, since such a session never reads `idle` and so gets no answers or PR feedback) write `{state, ts}` to `<worktree>/.tender/run/codex-state.json` on `SessionStart`/`Stop` (idle), `UserPromptSubmit`/`PostToolUse` (working), `PermissionRequest` (waiting) and `SessionEnd` (ended), only when `.tender/run` is a real directory. The sandbox only lets an agent write its own worktree, so it can at most misreport its own state. The hook runs with the agent's own privileges, so a race on `.tender/run` or the temp file reaches nothing the agent could not write anyway. It assumes the session starts at the worktree root, as the launcher does. Codex keys hook trust on the config file's path, so a fresh `<ID>.codex` would skip them; the launcher passes `--dangerously-bypass-hook-trust` instead, since the hooks come only from the template, which sessions cannot write. That also runs hooks from the repo's own `.codex/` config untrusted, with the session's own privileges. `tender` reads the file like `phases.json` (no symlinks, regular file under 4 KiB) and only if it is newer than the launcher; a `working` older than 10 minutes with no transcript write since is `unknown`.

### On a VM

Same steps on the VM (Tailscale for access), with `"sandbox": "none"` in `defaults` (or per repo) and `"host": "vm"` in `tender.json`. Tickets labelled `host:vm` go there. Connect your editor with Remote-SSH to `~/agent-ws/<owner>/<name>/<ID>`.

## Config reference

| key | default | |
|---|---|---|
| `host` | required | matches the `host:<host>` label |
| `defaultHost` | `false` | also take tickets with no `host:` label (not other hosts') |
| `pollIntervalMs` | `60000` | min 5000 |
| `workspaceRoot` | `~/agent-ws` | session clones (`<owner>/<name>/<ID>`), prompts, launchers, sidecars |
| `reposRoot` | `~/agent-repos` | `tender`-managed clones, `<owner>/<name>`, cloned when `run` or `once` starts |
| `tmuxSession` | `tender` | |
| `maxConcurrent` | `2` | sessions in total |
| `maxInReview` | unlimited | no new starts while this host has this many In Review plus Ready to merge tickets |
| `stallMinutes` | `30` | a session `working` with no transcript write for this long is parked, see **Stalled** below |
| `repos` | required | allowlist array: `"owner/name"`, or `{ "name": "owner/name", …overrides }`; tickets for other repos are skipped |
| `repos[].path` | `<reposRoot>/<owner>/<name>` | an existing `tender`-only clone; never your working clone |
| `defaults` / `repos[].baseBranch` | the remote's default branch | where `.tender/` is read and PRs target |
| `defaults` / `repos[].sandbox` | required in one of them | `nono` \| `none` |
| `defaults` / `repos[].maxConcurrent` | unlimited | sessions per repo, within the global `maxConcurrent` |
| `defaults` / `repos[].maxInReview` | unlimited | no new starts in the repo while it has this many In Review plus Ready to merge tickets on this host |
| `defaults` / `repos[].autoMerge` | `off` | the ceiling for the repo's request: `off` \| `shadow` \| `intelligent` \| `all`, see [Auto-merge](#auto-merge) |
| `defaults` / `repos[].criticalPaths` | `[]` | a floor of extra globs never auto-merged in `intelligent` / `shadow`, added to the built-in ones and the repo's; a per-repo list replaces the `defaults` one |
| `defaults` / `repos[].feedbackAuthors` | `[]` | GitHub logins / Linear emails (case-insensitive) whose replies answer agent questions and whose PR reviews and comments go back to the session, see [Questions](#questions) and [PR feedback](#pr-feedback); a per-repo list replaces the `defaults` one |
| `sources[].name` | required | `[a-z0-9-]`, unique |
| `sources[].tracker` | required | `github` \| `linear` |
| `readyLabel` | `agent` | ready label, GitHub and Linear |
| `needsHumanLabel` | `needs-human` | park label, GitHub and Linear; see **Parked** above |
| GitHub: `inProgressLabel`, `inReviewLabel`, `readyToMergeLabel` | `in-progress`, `in-review`, `ready-to-merge` | done = issue closed, unless as not planned or duplicate (canceled) |
| Linear: `team`, `todo`, `inProgress`, `inReview`, `readyToMerge`, `done` | —, `Todo`, `In Progress`, `In Review`, unset, `[Done]` | `team` is the key, e.g. `ENG`; `readyToMerge` unset keeps tickets In Review; a Canceled- or Duplicate-type state is canceled even if listed in `done` |

A source key its tracker does not use (e.g. `team` on a GitHub source, `inProgressLabel` on a Linear one) is rejected at startup. `agent`, `testCmd`, `planStep`, `prompt` and `testPaths` are rejected with `<key>: moved to .tender/config.yaml in the repo`.

### Repo config

How the agent works on a repo lives in the repo itself:

```
.tender/
  config.yaml        # optional
  prompts/
    default.md       # optional; else tender's prompts/default.md
    bug.md           # chosen by ticket label
  run/               # the agent's scratch dir, git-ignored by its own .gitignore
```

```yaml
agent: claude
testCmd: bun test
planStep: Load the `orchestration` skill and use it to plan and implement the ticket.
autoMerge: intelligent
criticalPaths: ["src/billing/**"]
prompts:
  byLabel:
    "type:bug": bug.md
tracker:
  linear:
    project: Web app
```

| key | default | |
|---|---|---|
| `agent` | `claude` | `claude` \| `codex` |
| `testCmd` | none | the agent must pass it before opening a PR; unset, the prompt tells it to find and run the project's tests |
| `planStep` | `Plan and implement the ticket.` | step 2 of the default prompt |
| `autoMerge` | the host's | the repo's request; the effective mode is the lower of it and the host's `autoMerge` (`off < shadow < intelligent < all`) |
| `criticalPaths` | `[]` | globs added to the built-in critical paths, `.tender/**` and the host's `criticalPaths`, see [Auto-merge](#auto-merge) |
| `testPaths` | `[]` | globs added to the built-in test paths |
| `prompts.default` | `default.md` if present | a file in `.tender/prompts/` |
| `prompts.byLabel` | `{}` | ticket label to prompt file; the first entry whose label the ticket has wins, else `prompts.default` |
| `tracker.linear.project` | none | the Linear project whose tickets come here when they name no repo themselves, see [Which repo a ticket goes to](#which-repo-a-ticket-goes-to) |
| `tracker.linear.team` | none | a Linear team key, only checked: a ticket routed here from another team's source is logged once |

`tender` reads `.tender/` only from `origin/<base>` in its own clone (`git ls-tree` and `git cat-file` on that commit, fetched before each start and once per poll before merge decisions or Linear project routing), never from a session clone, which the agent can write. A repo's config changes only when a commit to the base branch changes it; it is cached per base commit. Each file must be a regular file of at most 64 KiB, prompt files must be named `[a-z0-9-]+.md`, and unknown keys are errors. If it is invalid, that repo starts no tickets: `tender` logs the errors once per base commit and posts one `tender: not started` comment per base commit on the next ticket that names that repo and would have started (recorded in `<workspaceRoot>/.invalid-config/<owner>/<name>`). Meanwhile Linear tickets that rely on their project wait, with no comment. `.tender` itself must be a directory, not a symlink. Run `bun tender.ts check [path]` (default `.`) before committing: it validates `<path>/.tender/` from the working tree, prints the repo's settings with defaults filled in (the host's `autoMerge` ceiling and `criticalPaths` from `tender.json` still apply on top) and its tracker target (`tracker`, `null` if none), and exits non-zero if it is invalid.

Prompt placeholders: `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{testCmd}} {{tests}} {{repo}} {{planStep}}`. `{{tests}}` is `` `<testCmd>` ``, or "the project's tests (…)" when `testCmd` is unset; `{{testCmd}}` is then empty.

### Upgrading to `.tender/config.yaml`

Move `agent`, `testCmd`, `planStep` and `testPaths` (and any `criticalPaths` that belong to the repo rather than the host) from `tender.json` (`defaults` and each repo) into each repo's `.tender/config.yaml`, along with the `autoMerge` you want there (`tender.json`'s `autoMerge` is now its ceiling; its `criticalPaths` stay as a floor), and a custom `prompt` into `.tender/prompts/default.md`. Commit it to the base branch; `tender` does not read it from anywhere else. `baseBranch` now defaults to the remote's default branch. A session records its agent in `<ID>.agent` next to its clone; sessions started before have none and are treated as Claude sessions, so finish or restart running Codex sessions before upgrading.

### Upgrading from `aw`

`aw` is now `tender`. With nothing running (`systemctl --user disable --now aw && rm ~/.config/systemd/user/aw.service`), rename the config and the agent config dirs, then reinstall the service:

```bash
mv aw.json tender.json
mv ~/.claude-aw ~/.claude-tender && mv ~/.claude-aw.lock ~/.claude-tender.lock && mv ~/.codex-aw ~/.codex-tender
scripts/setup.sh && scripts/run.sh service   # enables tender.service
```

Delete the old `# >>> aw state hooks` block from `~/.codex-tender/config.toml` (`scripts/setup.sh` adds the `tender` one). Old `aw:` comments and `aw-findings` markers on open tickets are still recognised, but tender reads the agent scratch dir at `.tender/run/`, not `.aw/`, so finish or restart sessions started by `aw`. A `"tmuxSession": "aw"` in your config keeps working; the default is now `tender`.

### Upgrading from the `repos` map

`repos` used to be an object keyed by `"owner/name"`; that form is rejected at startup. Turn each `"owner/name": {}` into `"owner/name"` and each `"owner/name": { … }` into `{ "name": "owner/name", … }`. `sources[].repos` is gone (rejected at startup): a GitHub source polls every repo in `repos`. Worktrees moved from `<workspaceRoot>/<owner>__<name>/<ID>` to `<workspaceRoot>/<owner>/<name>/<ID>`; old ones are not seen any more. Finish or close those tickets first, or remove them by hand (`git -C <clone> worktree remove <old>`, then the `<ID>.*` files). To keep one, first stop its session (`tmux kill-window -t 'tender:<owner>__<name>/<ID>'`; `tender` would not recognise the old window name and would start a second session), then `git -C <clone> worktree move <old> <new>`, move `<ID>.phases.json` and `<ID>.source` alongside (create `<ID>.source` with the source name if there is none), and delete `<ID>.sh` and `<ID>.prompt.md`: they hold the old absolute paths and are regenerated when the ticket starts again. Move the ticket back to ready to resume in the moved worktree.

### Upgrading from `lanes`

`lanes` is rejected at startup. Move each lane's `repo` into `repos` (with its `repoPath` as `path`, plus `baseBranch`, `agent`, `sandbox`, `testCmd`, `maxConcurrent`, `prompt`) and keep the rest (`name`, `tracker`, labels, Linear states and `team`) as a source; Linear tickets or projects must now name their repo. Worktrees in the old `<workspaceRoot>/<lane>/<ID>` layout are not seen any more: finish or close those tickets first, or remove them by hand (`git -C <clone> worktree remove <workspaceRoot>/<lane>/<ID>`, then the `<ID>.*` files).

CLI: `bun tender.ts <run|once|status|watch|tail|check> [path] [--dry-run] [--json] [--interval s] [--plain] [-n N] [--no-follow] [--config tender.json]`.

## Code layout

- `tender.ts`: CLI entry (`run`, `once`, `status`, `watch`, `tail`, `check`).
- `src/types.ts`: shared types (`Config`, `Repo`, `Source`, `Ticket`, `Tracker`, `Io`).
- `src/config.ts`: `tender.json` parsing and the repo allowlist.
- `src/repo-config.ts`: a repo's `.tender/` read from its base branch, validated, cached per commit and combined with the host settings.
- `src/trackers/`: tracker adapters (`github.ts`, `linear.ts`) and the `TRACKERS` registry.
- `src/github.ts`: canonical-repo and PR lookup.
- `src/phases.ts`: `.tender/run/phases.json` validation and sub-ticket sync.
- `src/findings.ts`: `.tender/run/findings.json` validation, sanitizing and filing.
- `src/feedback.ts`: PR reviews, comments, failed checks and conflicts fed back into an idle In Review session.
- `src/merge.ts`: `.tender/run/merge.json`, critical paths, the merge decision, auto-merge and the Ready to merge check.
- `src/agents.ts`: the Claude and Codex adapters: launch env and command, config dirs and transcript files, live state (Claude's session records, read as untrusted files; the Codex hook state file).
- `src/launcher.ts`: base clone, session clone, prompt and launcher script, tmux window.
- `src/pass.ts`: one poll: cleanup, start ready tickets by priority, reconcile.
- `src/status.ts`: per-worktree status rows, the live-state snapshot and the table.
- `src/dash.ts`: the `watch` dashboard (OpenTUI): keys, selection, attach/open and the renderer wiring.
- `src/dash-view.ts`: the dashboard's pure view: palette, layout, cards, progress bars, detail and transcript rows, every screen line as styled spans.
- `src/state.ts`: live state types and precedence.
- `src/tail.ts`: transcript lookup by recorded cwd, line condensing, `tail`.
- `src/util.ts`: logged/dry-run-aware command and file helpers, the pinned `.tender/run` reader, control-char stripping.
- `scripts/codex-hooks.sh`: installs or refreshes tender's Codex state hooks in a `config.toml`.
- `tests/`: one file per module (launcher tests are in `pass.test.ts`); shared fakes in `tests/helpers.ts`.

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

## Status

Early and used by one person. Linux only (the pinned `.tender/run` reader uses `/proc`); macOS is untested. Auto-merge and the sandbox are guard rails, not guarantees: read [Auto-merge](#auto-merge) before enabling it, and protect `baseBranch` on GitHub. Bugs and ideas: open an issue.

## License

[MIT](LICENSE)
