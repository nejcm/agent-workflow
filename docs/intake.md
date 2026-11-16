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
    loopback: false                    # own network namespace with a usable loopback; see Sandbox
    labels: [shortcuts]                # on every ticket the rule files; see Labels
    autoLabel: []                      # empty = shadow: no ready label
    recheck: true                      # run --recheck after the ticket is Done
    recheckAfter: 24h
    private: false                     # file only into a private tracker; see Filing
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
- `pg-lint.ts` and `pg-slow.ts`: one ticket per Supabase database lint, and one per query that got slow since the last run. See [Postgres and Supabase](#postgres-and-supabase).

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

### Postgres and Supabase

Two scripts share `pg.ts` (copy it next to them) and one read-only role; they talk to Postgres with Bun's built-in client ([Bun SQL](https://bun.com/docs/runtime/sql)), so no `psql` is needed. Postgres 14 or later.

- `pg-lint.ts` runs the vendored [`splinter.sql`](../intake/splinter.sql) (copy it too), the SQL behind Supabase's database advisors, pinned to an upstream commit named in its first line, under its PostgreSQL license. One ticket per lint, most severe first, keyed `pg-lint:<name>:<hash of splinter's cache_key>`. Facts: `name`, `level` (`INFO`, `WARN`, `ERROR`), `categories` (`PERFORMANCE`, `SECURITY`, comma-joined). The body has the lint's detail, description, the object, the remediation link and the `cache_key`.
- `pg-slow.ts` diffs `pg_stat_statements` against the snapshot it kept in `TENDER_STATE` on its last run, for the current database, summed per `queryid` over roles, and only for plain DML (`select`, `insert`, `update`, `delete`, `with`, `merge`, `values`, `table`; utility statements are skipped). A query whose calls and mean time in that window are both over the thresholds gets a ticket keyed `pg-slow:<queryid>`, largest total time first. Facts: `calls`, `meanMs`, `totalMs`, all for the window. The body has the normalized query text: `pg_stat_statements` replaces constants with `$1`, `$2`… ([docs](https://www.postgresql.org/docs/current/pgstatstatements.html)), though under heavy entry churn an entry can keep its first literal values. The first run, a run after `pg_stat_statements_reset()` (its `stats_reset` moved) and a run after an unreadable state file only store the new snapshot and file nothing; so does a run whose `--user` list changed (the snapshot stores it). A query whose own counters went down (evicted or reset alone) starts over from this run; one evicted and re-created with more calls than before reads as one window of inflated delta. The script rewrites the snapshot on every collect, before tender files, so a window that fails to file is not retried: the query comes back only if it is still slow in a later window.

Each ticket tells the agent how to prove its fix in the PR: for a slow query, `EXPLAIN (ANALYZE, BUFFERS)` on the local database before and after, with representative values for the placeholders; for a lint, `splinter.sql` re-run locally without that `cache_key`.

Flags, set in the rule's `args`:

| Script | Flag | Default | |
|--------|------|---------|--|
| both | `--ca` | none | a PEM file (path in the repo) to verify the server against; without it TLS is required but unverified, like `sslmode=require` |
| `pg-lint.ts` | `--min-level` | `INFO` | `INFO`, `WARN` or `ERROR` |
| `pg-slow.ts` | `--min-mean-ms` | 100 | mean execution time in the window |
| `pg-slow.ts` | `--min-calls` | 50 | calls in the window |
| `pg-slow.ts` | `--user` | all | only queries run by this role; repeat for more |

```yaml
intake:
  - name: db-lints
    run: .tender/intake/pg-lint.ts
    args: [--ca, .tender/intake/supabase-ca.crt]
    every: 1d
    maxPerRun: 3
    secrets: [PG_INTAKE_URL]
    network: [aws-0-eu-central-1.pooler.supabase.com]
    loopback: true
    private: true
    labels: [supabase]
    autoLabel: [{ categories: PERFORMANCE }]
    recheck: true
    recheckAfter: 24h
  - name: db-slow
    run: .tender/intake/pg-slow.ts
    args: [--ca, .tender/intake/supabase-ca.crt, --min-mean-ms, "200", --user, authenticated, --user, anon]
    every: 1d
    maxPerRun: 2
    secrets: [PG_INTAKE_URL]
    network: [aws-0-eu-central-1.pooler.supabase.com]
    loopback: true
    private: true
    labels: [supabase]
    autoLabel: []
    recheck: true
    recheckAfter: 3d
```

- **Role:** one login role for both, never a Supabase access token. On Supabase, run this as `postgres` in the SQL editor:
  ```sql
  create role tender_intake login password '<long random>' connection limit 2;
  alter role tender_intake set default_transaction_read_only = on;
  alter role tender_intake set statement_timeout = '60s';
  grant pg_read_all_stats to tender_intake;          -- other roles' query text in pg_stat_statements
  grant usage on schema extensions to tender_intake; -- where Supabase installs pg_stat_statements
  grant usage on schema storage to tender_intake;    -- splinter reads storage.buckets; without these two the whole run fails
  grant select on storage.buckets to tender_intake;
  ```
  `pg-slow.ts` needs `pg_read_all_stats`: without it other roles' rows read `<insufficient privilege>`, and the script fails naming the grant, unless `--user` names only roles it can read. In Supabase's Postgres 17 image `postgres` lacks the ADMIN option on it and cannot grant it; whether hosted projects allow it is unverified. It also shows the lint script every query's text; two roles would need two secret names, one per rule, so this setup keeps one. `storage.buckets` has row level security with no policy for this role, so it reads no rows and splinter's public bucket lint stays quiet. Read-only is only a default: the role may `set` it off in its own session, so its grants are the real limit, and `PUBLIC` still has `EXECUTE` on functions and `TEMP` on the database (and `CREATE` on schema `public` on Postgres 14). Splinter otherwise reads the system catalogs and statistics views. Its table bloat lint reads `pg_stats`, which shows only tables the role can select, so it stays quiet for this role. Checked against Supabase's Postgres 17 image: the grants as `postgres`, except `pg_read_all_stats`; both scripts with that role.
- **Secret:** the role's URL as `PG_INTAKE_URL` in the host's `.env`, e.g. `postgres://tender_intake.<project ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` (Supavisor wants `<role>.<project ref>` as the user). Supabase's CA certificate (Database settings, SSL) committed into the repo is what `--ca` points at.
- **Network:** `network` names the database host and the rule sets `loopback: true`. Nono's network allowlist is an HTTP proxy, so a script cannot open a raw TCP connection anywhere; `pg.ts` opens a `CONNECT` tunnel through that proxy (which filters on host, not port) from a port on the script's own loopback, and Bun's client connects there, with TLS to the real host name. `loopback` is what lets it listen on that port: see [Sandbox](#sandbox).
- **Security lints:** a finding whose `categories` fact lists `SECURITY` never gets the ready label, whatever `autoLabel` says (see [Script protocol](#script-protocol)), and `tender check` rejects an `autoLabel` rule that names `SECURITY` in `categories`. Splinter's own category decides, and `pg-lint.ts` adds `SECURITY` to `auth_rls_initplan` and `multiple_permissive_policies`, which splinter files under `PERFORMANCE` but whose fix rewrites RLS policies; so RLS, policy, exposed-view and search-path lints are always shadow tickets: a human decides access policies. Other performance lints may be auto-labeled, as above. `tender check` does not also reject `name` conditions like `{ name: rls_disabled_in_public }`: every lint that touches policies carries `SECURITY`, so the categories guard already keeps such a rule from labeling, and a name list would go stale as splinter adds lints.
- **Slow queries** need a local database with realistic seed data for the agent to reproduce a plan, so turn on `autoLabel` for `pg-slow.ts` only in such repos.
- **Recheck:** for a lint, `still` while splinter still reports that `cache_key`. For a slow query, `still` while it is over both thresholds in the window from the last collect's snapshot to now; that window must start after the merge (`TENDER_DONE_AT`), so a recheck before the first collect after the merge, across a stats reset or a changed `--user` list, after the query's counters went down, while it is still over `--min-mean-ms` on fewer calls than `--min-calls`, or after it left `pg_stat_statements` since that snapshot fails and is retried next run; a query in neither snapshot had no calls, so it is `gone`. The window is one `every`, so give it enough traffic, and make `recheckAfter` cover the deploy: a merged migration or query change that has not reached the database still shows as `still`.
- **Private:** both example rules set `private: true`, since tickets show schema and query shapes; see [Filing](#filing).

## Script protocol

- **Collect:** `run` with the rule's `args` prints at most 100 JSON lines `{ "key", "title", "body", "facts"?, "fixes"? }` and exits 0. `key` is `[A-Za-z0-9.:/-]`, at most 128 chars, unique in the output. `facts` is a flat map of at most 20 numbers and strings, used by `autoLabel`; a `categories` fact that lists `SECURITY` (comma-separated, any case) means the finding never gets the ready label. `fixes` is an error tracker short ID (`^[A-Z0-9][A-Z0-9_-]{0,63}-[A-Z0-9]{1,32}$`, e.g. `WEB-1A2`); tender puts it on its own line `tender-intake-fixes: <ID>` right after the ticket's header, before the body, so truncation never drops it, and since script text is defanged no script or error text can write that line. The default prompt uses only that line for a `Fixes <ID>` and ignores any other request for one; a human editing the ticket on the tracker could still add one. Order by importance: `maxPerRun` takes the first new keys.
- **Recheck:** `run <args> --recheck <key>` prints one line `{ "state": "gone" | "still", "detail"? }`. A failed recheck (non-zero exit, timeout or malformed line) is logged and retried next run; it does not stop the rule's other rechecks or its collect. `TENDER_DONE_AT` holds the ISO time the clock counts from: the merge of `agent/<ID>`, or when tender first saw the ticket Done.
- **Limits:** 5 minutes and 1 MiB of output. A timeout, a non-zero exit, too much output or any malformed line fails that run, which is logged and files nothing.
- **Environment:** `TENDER_STATE` (a file the script may rewrite, kept between runs: `<workspaceRoot>/.intake/<owner>/<name>/<rule>.state`), `TENDER_RULE`, `TMPDIR`, `PATH`, `HOME`, `LANG` and the declared `secrets`. Nothing else.

## Sandbox

Each run gets a fresh `git clone --shared` of `origin/<base>` in `<workspaceRoot>/.intake/<owner>/<name>/<rule>/`, deleted afterwards. The script always runs under `nono/tender-intake.json`, whatever the repo's `sandbox`, and fails if nono cannot run: it can write only that clone, its temp dir and its state file, read the base clone's objects and system paths, reach only the `network` hosts (through nono's proxy, which filters on host name: plain TCP clients must tunnel with HTTP `CONNECT`), and sees only the secrets it declares, read from the host environment (`.env`, loaded by Bun from the working directory). Secret names starting with `GH_`, `GITHUB_`, `LINEAR_` and other tender or agent names are rejected, so no `gh` token or tracker key ever reaches a script. The script's output is untrusted data. With `loopback: true` the script also runs in its own network namespace (nono's `linux.isolate`) whose loopback it may listen and connect on, so it can run a local tunnel like `pg.ts`'s; egress still goes only through the proxy, and the host's own localhost is out of reach. It needs unprivileged user namespaces (AppArmor on recent Ubuntu may restrict them); without them nono fails to start and so does the run. Tested with nono 0.81.0; older nono may lack `linux.isolate`.

## Filing

- **Where:** the repo's Linear project when `.tender/config.yaml` sets `tracker.linear` (the one Linear source, or the one for its `team`), else the repo's GitHub issues through the one GitHub source.
- **Private:** a rule with `private: true` files into GitHub only if `gh repo view --json visibility` says the repo is private or internal, asked once per repo per run before the script runs; a public repo, or a failed or odd answer, fails the run with a logged error and files nothing. It checks the GitHub repo with a Linear tracker too, since the fix PR lands there.
- **Sanitized** as [findings](lifecycle.md#findings): a one-line title of at most 120 chars, control characters stripped, `@` mentions and Linear links neutralized, and `tender-intake` in script text rewritten to `tender_intake`, so a script cannot plant another key's marker. The body opens with "Untrusted data from tender intake rule <rule>", ends with the marker line `tender-intake: <owner>/<name>:<rule>:<key>`, and is at most 4000 chars in all.
- **Dedupe, three layers:** the marker in the body, matched only as a whole line (key `a` never matches `abc`); the `intake_seen` table in `tender.db`; and, before every create, a tracker search for the marker (any state), so a lost database adopts the existing ticket instead of filing a second. A key is filed at most once, ever.
- **Labels:** with `autoLabel` rules, a finding whose facts satisfy any rule gets the ready label (plus `host:<host>` unless `defaultHost`). A rule is a map: `min<Fact>: n` means `facts.<fact> >= n`, any other key is equality; `{ minEvents: 100, level: error }`. Without a match: no ready label (shadow); the rule's `labels` are added either way.
- **Seen again while open:** `last_seen_at` is updated, and at most once a day a comment lists the new facts if they changed noticeably (a fact added, dropped, a string changed or a number moved by half). Never refiled.
- **Recheck:** once tender sees the ticket Done, `--recheck <key>` runs on the first intake run `recheckAfter` later. `still` posts one comment and reopens it (GitHub) or moves it to Todo (Linear), removing the ready label first; if that removal fails the ticket stays closed. A ticket is rechecked and reopened at most once, except in one case: a reopen that takes effect but reports failure (or tender crashing before recording it), followed by a human closing the ticket before the next run, is reopened again. the comment ends with a `tender-intake-recheck: <rule>:<key>` line and is posted before the reopen, which only follows once it lands. Tender looks for that line before any recheck, so a lost `tender.db` cannot cause a second reopen. A failed comment or reopen is retried next run, unless recheck was turned off or the ticket canceled meanwhile; if `tender.db` is lost between the comment and a failed reopen, the reopen is dropped rather than risk a second one. A marker search that returns over 100 near misses for a key fails the run instead of filing a possible duplicate. `recheckAfter` counts from the merge of `agent/<ID>`, or, for a ticket tender did not merge, from when it first saw it Done. Turning `recheck` off, or a human reopening or canceling the ticket, drops a pending recheck.
- **History:** each filing records an `intake-filed` event in `tender.db`.
