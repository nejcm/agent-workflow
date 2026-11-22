# PR sweep

`tender prs` looks at every open PR in the allowlisted repos once a week. It closes orphan agent PRs and reports everything else; it never labels, comments on, merges, rebases or pushes to any other PR.

```bash
bun tender.ts prs [--dry-run]
```

`scripts/run.sh prs-service` installs `systemd/tender-prs.service` and `.timer`, which run it every Monday at 09:00 (a missed run catches up at the next boot). Install it on one host: each run rewrites the digest, and a live session is only seen on the host that runs it. Like `intake`, it is a separate command with its own lock (`<workspaceRoot>/.prs.lock`) and never runs inside the poll.

## Listing

Per repo: `gh pr list --state open --limit 200`. A repo with more open PRs is swept for its first 200 only, and the report says so. A repo whose name GitHub resolves to another repo, or whose listing fails, is skipped and logged.

## Orphans: closed at once

A PR is an orphan when all of these hold:

- its head branch is `agent/<ID>`, tender's branch for ticket `<ID>`;
- it is from the same repo, not a fork;
- the ticket is done, canceled or deleted, read from its tracker in this run (the same `closed` check as cleanup). The tracker is the source named in `<ID>.source` when that sidecar is still there; otherwise every GitHub source for `gh-<n>` ids, or every Linear source whose `team` is the id's prefix. All of them must say done, canceled or deleted; an open state, no matching source or a tracker error leaves the PR open.

An orphan is still not closed while:

- the ticket is handed off (`<ID>.handoff`, see [Hand-off](hand-off.md#hand-off));
- this host's tmux session has a window for it;
- the window listing failed and tmux did not answer that the server or session is missing (a timeout or any other error counts as a possible live window).

The ticket's state is read a second time right before the close; one no longer done, canceled or deleted is left open. Then, under the poll's lock (`<workspaceRoot>/.pass.lock`, shared with `run`, `open` and `resume`), the hand-off and tmux checks run again and the PR is closed, so a session can't start or be handed off in between. Only local tmux calls (5 s each) and the close and branch delete (20 s each) run under the lock, so one orphan holds it under 90 seconds, kill and drain included. A timed-out close counts as failed: the branch is kept and the next sweep tries again. A ticket reopened after that second read (including while waiting for the lock) can still lose its PR and branch: reopen the PR and restore the branch from its page on GitHub.

Closing posts one comment, `tender: closed, ticket <ID> is done` (or `canceled`, `deleted`), closes the PR, deletes the `agent/<ID>` branch through the GitHub API and appends a `pr-closed` event to `tender.db`. A failed branch delete is logged; the PR stays closed.

## Report

Every other PR, human or agent, is only reported, with one or more classes:

| class | when |
|---|---|
| `conflicting` | GitHub reports a merge conflict |
| `failing` | a check failed, errored, timed out or was canceled |
| `stale` | not a draft, no update in `staleDays` |
| `draft-stale` | a draft, no update in `staleDays` |
| `ready` | GitHub's merge state is clean (checks, reviews and branch rules all pass) and the PR is older than `staleDays`: only a human merge is missing |

Agent PRs also show `ticket <ID> state unknown` when the tracker lookup failed, and orphans show what happened to them. PRs with nothing to report are left out. Titles are cut to 120 characters, their Markdown and HTML characters escaped and bare URLs, `www.` names and emails broken with zero-width spaces around `:` and `.` so GitHub does not autolink them, and `@mentions` broken so the digest pings no one.

The report is printed to stdout (the journal under the timer). With `prs.digestIssue` set, that issue's body is replaced with it on each run (cut at 30,000 characters).

`--dry-run` reads GitHub and the trackers but closes, deletes, records and rewrites nothing; the report says `would close` and the log lists each command it skipped.

## Config

```json
"prs": { "staleDays": 14, "digestIssue": "acme/web#42" }
```

See [Config reference](config.md#prs). Without `prs`, `tender prs` runs with the defaults and no digest.

On GitHub the agent shares the operator's `gh` login, so a PR comment it posts counts as the operator's and is fed back as a new round (bounded by the round limit); not replying on the PR is a prompt rule. Use a separate agent account to make it a boundary.
