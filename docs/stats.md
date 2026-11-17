# Trust signals

`tender stats` shows how agent PRs fared per repo and per trust path, so you can decide when to raise a path's [`autoMerge`](auto-merge.md#auto-merge). It only reads: no GitHub, tracker or config writes. It recommends; it never changes `autoMerge`, which stays a human edit.

```bash
bun tender.ts stats [--days 90] [--json]
```

`--json` prints the same data as the table. Log lines go to stderr. `tender.db` is opened read-only: its content is never written, and it is never created or migrated (SQLite may create its `-wal` and `-shm` sidecars). A missing file, or tables an older schema lacks, count as no history.

## Window and bounds

Per allowlisted repo: `gh pr list --state all --search created:>=<date> --limit 500`, so only PRs opened in the last `--days` (default 90, at most 3650) count, at most the newest 500 per repo; a repo that reaches 500 is flagged, as older PRs may be missing (`truncated` in `--json`). Events count only when recorded in the same window. A repo whose name GitHub resolves to another repo, or whose listing fails, is reported as skipped.

## Trust path

An agent PR is a same-repo PR from `agent/<ID>`, as for [`tender prs`](prs.md#orphans-closed-at-once). Its path is the repo's first [`trust`](config.md#repo-config) rule matching its files, read from `.tender/` at `origin/<base>` in the clone (not fetched); `(rest)` when no rule matches any file. `(mixed)` holds PRs whose files fall under different rules (or some under a rule and some under none), PRs with a renamed file (GraphQL's file list has no old path) and PRs with no files or 100 or more (the list may be cut): their mode is unknown, so `(mixed)` shows `-` and never gets a recommendation. The `mode` column is that path's mode today (the rule's or repo's `autoMerge`, capped by the host's), not the mode each PR was decided under. Without a readable `.tender/`, PRs are mapped as if there were no trust rules, the totals are still shown, and the repo gets no recommendation (`configError` in `--json`).

## Columns

From GitHub, so every host sees the same numbers:

- `merged`: agent PRs merged.
- `reverted`: merged agent PRs that a later (higher-numbered) merged PR in the same repo reverts with GitHub's own `Reverts owner/repo#N` line (the revert button). A hand-made revert, or one in another repo, is not counted.
- `hours`: median hours from PR opened to merged.

From this host's `tender.db` events, so another host's sessions are not seen:

- `rounds`: mean `feedback-round` events per merged PR's ticket.
- `shadow`: `agreed/total` over PRs that got a `gate` event in `shadow` mode and are no longer open, using the PR's last one. It agrees when `would auto-merge` was then merged at the head it judged, or `not auto-merged` was not (closed, or merged after a new push). A PR tender later auto-merged (its `merged` event says `auto`, e.g. after the path moved to `intelligent`) is left out, as no human judged it; it assumes one host makes merge decisions for a repo: an auto-merge by another host is not seen and counts as a human merge. The table's closing note and `shadowAssumes` in `--json` say so.

Per repo, also from events:

- `judge`: each verdict (not one adopted from a comment) against what happened next. *Worked*: the ticket had a `start` event after the verdict. *Closed*: no start, and intake last saw the ticket `closed` or `done` (a `reopened` or `reopening` ticket is not closed). Agreed: the judge added the ready label and it was worked, or held it in shadow and it was closed. Disagreed: labelled but closed without work, or held but labelled by hand and worked. Neither is *not acted on*, outside the ratio.
- `recheck`: reopens out of rechecks, from the `recheck` event intake records per ticket: `gone` when the recheck closes it, `still` only once the reopen has landed (or a later sweep finds the ticket open again after a reopen that reported failure), so a failed or dropped reopen is not counted.

## Recommendations

A path gets one line, one mode up, when all of these hold (constants in `src/stats.ts`):

- at least 20 merged (`MIN_MERGED`) and no revert;
- from `shadow` to `intelligent`: at least 20 shadow decisions (`MIN_SHADOW`) agreeing at 95% or more (`MIN_AGREE`);
- from `intelligent` to `all`: nothing more.

`off` and `(mixed)` never get one: turning on `shadow` costs nothing and is your call. A line says the thresholds are met and what the evidence does not cover, never that a mode is safe. For example: `acme/web docs/**: 40 merged, 0 reverts, shadow agreed 38/40 → consider \`intelligent\` (now \`shadow\`): thresholds met, but hand-made reverts are not counted`. From `intelligent`, the line says instead that the sample cannot show how large changes, edited tests and unassessed medium changes fare, which `all` also merges.
