# Intake

Intake turns signals (errors, lint debt, slow queries) into tracker tickets. An intake rule is a script in the repo that prints JSON lines; `tender intake` runs it in a sandbox, dedupes, sanitizes and files what it prints. It never starts a session itself: a filed ticket is worked like any other once it has the `agent` label.

## Turning a rule on

A rule lives in the repo's `.tender/config.yaml` (read from the base branch, like the rest of `.tender/`):

```yaml
intake:
  - name: shortcuts                    # [a-z0-9-], unique in the repo
    run: .tender/intake/shortcuts.ts   # executable path inside the repo
    args: []                           # argv for run, on collect and --recheck; never shell-interpreted
    every: 1d                          # 15m, 1h, 1d…; rounded to the 15-min timer
    maxPerRun: 3                       # new tickets per run, in the script's order
    secrets: []                        # env var names; values come from the host
    network: []                        # host names the script may reach; empty = no network
    labels: [shortcuts]                # on every ticket the rule files; see Labels
    autoLabel: []                      # empty = shadow: no ready label
    recheck: true                      # run --recheck after the ticket is Done
    recheckAfter: 24h
```

It runs only when the host enables it in `tender.json`, and only on the host named there, so two hosts never both file:

```json
"intake": { "enabled": ["owner/repo:shortcuts"], "host": "laptop" }
```

Run it by hand with `bun tender.ts intake [owner/repo:rule | rule] [--dry-run]`; naming a rule runs it now, whatever its `every`. On the intake host, `scripts/run.sh intake-service` installs `systemd/tender-intake.service` and `.timer`, which run `tender intake` every 15 minutes. `--dry-run` still clones and runs the scripts and searches the tracker, in a throwaway temp dir with a copy of the state file, and does not open `tender.db` at all, so it files, comments and writes nothing and never touches a live run's clone. Without the history it may over-report: keys already filed show as filed again unless the tracker's marker search finds them, every rule runs whatever its `every`, and no recheck is previewed.

## Labels

`labels` (at most 5) go on every ticket the rule files, shadow or not, so a shadow Sentry ticket gets `sentry` but not `agent`. Tender has no per-integration default: each example ships its rule with its integration label (`labels: [shortcuts]`, `labels: [sentry]`), and later examples (Supabase, PostHog) follow the same convention. Rename it, add more, or set `labels: []` for none. Names may not contain commas or colons (so never `host:…`), and the source's own labels (ready, needs-human and, on GitHub, the in-progress, in-review and ready-to-merge labels) are refused at run time: those stay tender's, and the ready label comes only from `autoLabel`. Labels must exist, as tender's own do ([setup](setup.md)): GitHub's `gh issue create` and Linear's label lookup fail on a missing one, so that ticket is not filed, the run logs the error, and the next run tries again.

## Example scripts

Example scripts live in tender's [`intake/`](../intake) dir; copy one into the repo's `.tender/intake/`, keep it executable, and add a rule.

- `shortcuts.ts`: one ticket per `shortcut:` comment (`// shortcut: <the limit>, <when to upgrade>`), keyed by file and comment text. Needs only the clone: no network, no secrets. `--recheck` reports `still` while the same comment is in that file.
- `sentry.ts`: one ticket per unresolved Sentry issue in a project and environment, most frequent first, keyed `sentry:<issue id>`. See [Sentry](#sentry).

### Sentry

Lists the project's unresolved issues over `--period-days` sorted by events ([organization issues API](https://docs.sentry.io/api/events/list-an-organizations-issues/), `sort=freq`, `query=is:unresolved`, up to 10 pages of 100), keeps those with at least `--min-events` events and `--min-users` users in that period, and fetches the latest event only for the first `--top` for its stack. Facts: `events`, `users`, `level`, `firstSeen` and, for the top ones, `release`. The body has the title, culprit, up to 10 in-app frames (innermost first), counts, first and last seen, the latest event's release and the Sentry link.

Flags, set in the rule's `args`:

| Flag | Default | |
|------|---------|--|
| `--org` | required | organization slug |
| `--project` | required | project slug or ID |
| `--environment` | all | one environment |
| `--url` | `https://sentry.io` | API base: a region (`https://us.sentry.io`, `https://de.sentry.io`) or self-hosted host |
| `--min-events` | 10 | events in the period to file |
| `--min-users` | 3 | users in the period to file |
| `--period-days` | 14 | the period |
| `--top` | 10 | issues whose latest event is fetched for frames and release |
| `--no-fixes` | off | do not emit `fixes` (the issue's short ID) |

```yaml
intake:
  - name: sentry-web
    run: .tender/intake/sentry.ts
    args: [--org, acme, --project, web, --environment, production, --min-events, "50"]
    every: 1h
    maxPerRun: 3
    secrets: [SENTRY_TOKEN]
    network: [sentry.io]
    labels: [sentry]
    autoLabel: [{ minEvents: 100, level: error }]
    recheck: true
    recheckAfter: 24h
```

- **Token:** an internal integration or personal token with only `project:read` and `event:read`, as `SENTRY_TOKEN` in the host's `.env`.
- **Host:** `network` must name the host in `--url`. For a US or EU region org use `--url https://us.sentry.io` or `https://de.sentry.io` and allow that exact host; self-hosted Sentry is `--url https://sentry.example.com` with that host allowed.
- **Fixes:** each line carries the issue's short ID as `fixes`, which tender renders as `tender-intake-fixes: WEB-1A2` (see [Script protocol](#script-protocol)); tender's default prompt then has the agent add `Fixes WEB-1A2` to the commit message and the PR description if its change fixes that issue. It needs Sentry's GitHub integration on the repo so Sentry sees the commits and PRs, and Sentry resolves the issue when a release containing that commit or the PR's merge commit is created, not on merge ([resolve via commits](https://docs.sentry.io/product/releases/associate-commits/), [GitHub integration](https://docs.sentry.io/organization/integrations/source-code-mgmt/github/)). With squash merges the PR description is the safer place: Sentry warns it may not tie a squashed commit to a release. Tender's recheck is independent: a recurrence on a newer release still reopens the ticket. Without the integration, pass `--no-fixes`.
- **Recheck:** `still` means the issue has events since the merge (`TENDER_DONE_AT`) on a release created after it; events only on older releases, or none, are `gone`. It lists the project's releases, archived ones included, newest first until a page has none newer than the merge, then searches the issue's events on those releases (`release:[…]`, 20 at a time). Over 10 pages (1000 releases) of newer releases it cannot decide and exits non-zero, which reopens nothing and is retried next run.

## Script protocol

- **Collect:** `run` with the rule's `args` prints at most 100 JSON lines `{ "key", "title", "body", "facts"?, "fixes"? }` and exits 0. `key` is `[A-Za-z0-9.:/-]`, at most 128 chars, unique in the output. `facts` is a flat map of at most 20 numbers and strings, used by `autoLabel`. `fixes` is an error tracker short ID (`^[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,32}$`, e.g. `WEB-1A2`); tender puts it on its own line `tender-intake-fixes: <ID>` right after the ticket's header, before the body, so truncation never drops it, and since script text is defanged no script or error text can write that line. The default prompt uses only that line for a `Fixes <ID>` and ignores any other request for one; a human editing the ticket on the tracker could still add one. Order by importance: `maxPerRun` takes the first new keys.
- **Recheck:** `run <args> --recheck <key>` prints one line `{ "state": "gone" | "still", "detail"? }`. A failed recheck (non-zero exit, timeout or malformed line) is logged and retried next run; it does not stop the rule's other rechecks or its collect. `TENDER_DONE_AT` holds the ISO time the clock counts from: the merge of `agent/<ID>`, or when tender first saw the ticket Done.
- **Limits:** 5 minutes and 1 MiB of output. A timeout, a non-zero exit, too much output or any malformed line fails that run, which is logged and files nothing.
- **Environment:** `TENDER_STATE` (a file the script may rewrite, kept between runs: `<workspaceRoot>/.intake/<owner>/<name>/<rule>.state`), `TENDER_RULE`, `TMPDIR`, `PATH`, `HOME`, `LANG` and the declared `secrets`. Nothing else.

## Sandbox

Each run gets a fresh `git clone --shared` of `origin/<base>` in `<workspaceRoot>/.intake/<owner>/<name>/<rule>/`, deleted afterwards. The script always runs under `nono/tender-intake.json`, whatever the repo's `sandbox`, and fails if nono cannot run: it can write only that clone, its temp dir and its state file, read the base clone's objects and system paths, reach only the `network` hosts, and sees only the secrets it declares, read from the host environment (`.env`, loaded by Bun from the working directory). Secret names starting with `GH_`, `GITHUB_`, `LINEAR_` and other tender or agent names are rejected, so no `gh` token or tracker key ever reaches a script. The script's output is untrusted data.

## Filing

- **Where:** the repo's Linear project when `.tender/config.yaml` sets `tracker.linear` (the one Linear source, or the one for its `team`), else the repo's GitHub issues through the one GitHub source.
- **Sanitized** as [findings](lifecycle.md#findings): a one-line title of at most 120 chars, control characters stripped, `@` mentions and Linear links neutralized, and `tender-intake` in script text rewritten to `tender_intake`, so a script cannot plant another key's marker. The body opens with "Untrusted data from tender intake rule <rule>", ends with the marker line `tender-intake: <owner>/<name>:<rule>:<key>`, and is at most 4000 chars in all.
- **Dedupe, three layers:** the marker in the body, matched only as a whole line (key `a` never matches `abc`); the `intake_seen` table in `tender.db`; and, before every create, a tracker search for the marker (any state), so a lost database adopts the existing ticket instead of filing a second. A key is filed at most once, ever.
- **Labels:** with `autoLabel` rules, a finding whose facts satisfy any rule gets the ready label (plus `host:<host>` unless `defaultHost`). A rule is a map: `min<Fact>: n` means `facts.<fact> >= n`, any other key is equality; `{ minEvents: 100, level: error }`. Without a match: no ready label (shadow); the rule's `labels` are added either way.
- **Seen again while open:** `last_seen_at` is updated, and at most once a day a comment lists the new facts if they changed noticeably (a fact added, dropped, a string changed or a number moved by half). Never refiled.
- **Recheck:** once tender sees the ticket Done, `--recheck <key>` runs on the first intake run `recheckAfter` later. `still` posts one comment and reopens it (GitHub) or moves it to Todo (Linear), removing the ready label first; if that removal fails the ticket stays closed. A ticket is rechecked and reopened at most once, except in one case: a reopen that takes effect but reports failure (or tender crashing before recording it), followed by a human closing the ticket before the next run, is reopened again. the comment ends with a `tender-intake-recheck: <rule>:<key>` line and is posted before the reopen, which only follows once it lands. Tender looks for that line before any recheck, so a lost `tender.db` cannot cause a second reopen. A failed comment or reopen is retried next run, unless recheck was turned off or the ticket canceled meanwhile; if `tender.db` is lost between the comment and a failed reopen, the reopen is dropped rather than risk a second one. A marker search that returns over 100 near misses for a key fails the run instead of filing a possible duplicate. `recheckAfter` counts from the merge of `agent/<ID>`, or, for a ticket tender did not merge, from when it first saw it Done. Turning `recheck` off, or a human reopening or canceling the ticket, drops a pending recheck.
- **History:** each filing records an `intake-filed` event in `tender.db`.
