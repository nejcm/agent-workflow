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

`labels` (at most 5) go on every ticket the rule files, shadow or not, so a shadow Sentry ticket gets `sentry` but not `agent`. Tender has no per-integration default: each example ships its rule with its integration label (`labels: [shortcuts]`, `labels: [sentry]`), and later examples (Supabase, PostHog) follow the same convention. Rename it, add more, or set `labels: []` for none. Names may not contain commas or colons (so never `host:…`), and the source's own labels (ready, needs-human and, on GitHub, the in-progress, in-review and ready-to-merge labels) are refused at run time: those stay tender's, and the ready label comes only from `autoLabel` or the [judge](#judge). Labels must exist, as tender's own do ([setup](setup.md)): GitHub's `gh issue create` and Linear's label lookup fail on a missing one, so that ticket is not filed, the run logs the error, and the next run tries again.

## Example scripts

Example scripts live in tender's [`intake/`](../intake) dir; copy one into the repo's `.tender/intake/`, keep it executable, and add a rule.

- `shortcuts.ts`: one ticket per `shortcut:` comment (`// shortcut: <the limit>, <when to upgrade>`), keyed by file and comment text. Needs only the clone: no network, no secrets. `--recheck` reports `still` while the same comment is in that file.
- `sentry.ts`: one ticket per unresolved Sentry issue in a project and environment, most frequent first, keyed `sentry:<issue id>`. See [Sentry](#sentry).
- `posthog-errors.ts`: one ticket per active PostHog error tracking issue, most frequent first, keyed `posthog:<issue id>`. See [PostHog](#posthog).
- `pg-lint.ts` and `pg-slow.ts`: one ticket per Supabase database lint, and one per query that got slow since the last run. See [Postgres and Supabase](#postgres-and-supabase).
- `lint-debt.ts`: existing violations of one lint rule, a batch of files per ticket. See [Lint debt](#lint-debt).

The plan named a shell script for lint debt; it is TypeScript like the others, so its parsing and batching are tested.

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

### PostHog

Lists the project's active error tracking issues over `--period-days`, most occurrences first ([`error_tracking/query/issues`](https://posthog.com/docs/open-api-spec/error_tracking_query_issues_list_create), `status: active`, `orderBy: occurrences`, up to 10 pages of 100), keeps those with at least `--min-events` occurrences and `--min-users` users in that period, and fetches the latest exception event only for the first `--top` ([`error_tracking/query/issue_events`](https://posthog.com/docs/open-api-spec/error_tracking_query_issue_events_create)) for its stack. Both endpoints are PostHog's typed error tracking queries; tender does not use the HogQL `/query` endpoint, which rejects `OFFSET` for personal API keys and is [not meant for pulls like this](https://posthog.com/docs/api/queries). Counts follow PostHog's defaults, so test accounts are filtered out. Facts: `events`, `users`, `firstSeen`, `severity` (`low`, `medium`, `high`, `critical`) when the issue has one, and, for the top ones when the event has them, `level` (`$exception_level`) and `release`. A count that is not a number fails the run. The body has the issue name and message, up to 10 in-app frames (innermost first), counts, first and last seen, the latest event's release and the PostHog link.

Flags, set in the rule's `args`:

| Flag | Default | |
|------|---------|--|
| `--project` | required | project ID (Project settings) |
| `--url` | `https://us.posthog.com` | app host: `https://eu.posthog.com` for EU Cloud, or the self-hosted host |
| `--min-events` | 10 | occurrences in the period to file |
| `--min-users` | 3 | users in the period to file |
| `--period-days` | 14 | the period |
| `--top` | 10 | issues whose latest exception is fetched for frames, level and release |

There is no `--environment`: PostHog's issue query has no environment filter.

```yaml
intake:
  - name: posthog-web
    run: .tender/intake/posthog-errors.ts
    args: [--project, "12345", --url, https://eu.posthog.com, --min-events, "50"]
    every: 1h
    maxPerRun: 3
    secrets: [POSTHOG_TOKEN]
    network: [eu.posthog.com]
    labels: [posthog]
    autoLabel: []   # shadow; see Auto-labeling below
    recheck: true
    recheckAfter: 24h
```

- **Token:** a [personal API key](https://posthog.com/docs/api/personal-api-keys) scoped to that project with only `error_tracking:read`, the scope both endpoints require, as `POSTHOG_TOKEN` in the host's `.env`.
- **Host:** `network` must name the host in `--url`: `us.posthog.com` or `eu.posthog.com` ([private endpoints](https://posthog.com/docs/api), not the `*.i.posthog.com` ingestion hosts), or the self-hosted host.
- **No fixes:** PostHog has no resolve-by-commit (`Fixes <ID>`) integration and no short issue IDs; its GitHub integration links stack frames to source and creates issues ([integrations](https://posthog.com/docs/error-tracking/integrations)). So the script emits no `fixes`, and resolving the PostHog issue is left to a human or to PostHog reopening it on recurrence.
- **Auto-labeling:** `events`, `users` and `level` come from exception events, which anyone can send with the public project token in your web pages, so 100 forged exceptions from 3 IDs would meet `{ minEvents: 100 }`. `severity` lives on the issue, but PostHog's severity rules can set it from event data (`severity_rules.py`, `severity_inference.py` in PostHog's source), so it is no stronger. Keep the rule shadow unless you accept that.
- **Recheck:** `still` means the issue has an event since the merge (`TENDER_DONE_AT`) on a release created strictly after it; `gone` means no such event. As in Sentry's script, events without a release are ignored (the `gone` detail counts them): they may come from the old build, between the merge and the deploy or from stale tabs. A release is the one `posthog-cli` creates when you upload source maps or symbols, or the one you create at deploy for Python, Ruby and PHP ([releases](https://posthog.com/docs/error-tracking/releases)), and its creation time is what each event carries in `$exception_release`. A project without releases therefore always gets `gone`, which is no check at all: set `recheck: false` there. It reads the issue's events since the merge newest first, 20 at a time, and fails rather than guess (non-zero exit, nothing reopened, retried next run) on a release or event timestamp it cannot read, an event dated before the merge, over 10 pages (200 events) with none on a newer release, or a 404: a deleted issue and a wrong `--project` look the same, and the latter must not close every ticket as `gone`.

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

### Lint debt

Runs the lint command given after `--` in the rule's `args` (never through a shell), reads every line shaped `path:line[:col]: …`, and files the failing files in batches of `--batch`, in sorted order. Use it after a rule (often a [guardrail](#guardrails)) lands, to clear the existing copies agents would otherwise imitate. The command must report only the one rule, so select it there (`--select`, `--rule`, a dedicated config).

| Flag | Default | |
|------|---------|--|
| `--rule` | required | the rule's name, for the key, title and facts |
| `--batch` | 5 | files per ticket, 1–50 |
| `--install` | off | run `bun install --frozen-lockfile --ignore-scripts` first (cache in `TMPDIR`); needs `registry.npmjs.org` in `network` and a `bun.lock` |

Formats that parse: ESLint `--format unix` (built in up to ESLint 8; ESLint 9 needs the `eslint-formatter-unix` package in `devDependencies`; absolute paths are made relative to the clone), Ruff `--output-format concise`, ShellCheck `-f gcc`, mypy's default output. Other lines (summaries, blanks) and paths outside the clone are ignored. Exit 0 and 1 are a run (linters exit 1 when they report); 1 with nothing parsed, any other code, or a missing command fails the run.

- **Sandbox:** the clone is a fresh checkout of the base branch with no `node_modules` or virtualenv and, by default, no network. A linter that is a system binary readable in the sandbox (`/usr/bin`, `/usr/local/bin`; not `~/.local/bin`) runs as is. A Node linter whose config imports plugins needs `--install` and the registry in `network`; install plus lint must fit the 5-minute limit.
- **Keys:** `lint-debt:<rule>:<hash of the batch's file list>`. The batches are kept in `TENDER_STATE`, so a batch keeps its key while any of its files still fails, and newly failing files form new batches instead of shifting the old ones. Facts: `rule`, `files`, `violations`.
- **Recheck:** runs the whole command again and looks at the batch's files: `gone` when none fails, `still` (naming them) otherwise. A key missing from the state file, or a failed lint, cannot be decided: non-zero exit, retried next run. A file that fails again after its batch went clean is reported only by that one recheck.
- **Auto-labeling:** the lint rule is the proof, so this is the safest kind to label automatically, with `autoLabel: [{ rule: <name> }]` as below.

```yaml
intake:
  - name: lint-debt-floating
    run: .tender/intake/lint-debt.ts
    args: [--rule, no-floating-promises, --batch, "5", --install, --, bun, node_modules/eslint/bin/eslint.js, --format, unix, --config, eslint.debt.config.js, src]
    every: 1d
    maxPerRun: 2
    secrets: []
    network: [registry.npmjs.org]
    labels: [lint-debt]
    autoLabel: [{ rule: no-floating-promises }]
    recheck: true
    recheckAfter: 1h
```

Here `eslint.debt.config.js` turns on only that rule, and ESLint runs under Bun, which the sandbox can always read (a Node from mise or nvm is not). A system linter needs no install and no network: `args: [--rule, F401, --, ruff, check, --select, F401, --output-format, concise, .]` with `network: []`.

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
- **Recheck:** once tender sees the ticket Done, `--recheck <key>` runs on the first intake run `recheckAfter` later. `still` posts one comment and reopens it (GitHub) or moves it to Todo (Linear), removing the ready label first; if that removal fails the ticket stays closed. A ticket is rechecked and reopened at most once, except in one case: a reopen that takes effect but reports failure (or tender crashing before recording it), followed by a human closing the ticket before the next run, is reopened again. the comment ends with a `tender-intake-recheck: <rule>:<key>` line and is posted before the reopen, which only follows once it lands. Tender looks for that line before any recheck, so a lost `tender.db` cannot cause a second reopen. A failed comment or reopen is retried next run, unless recheck was turned off or the ticket canceled meanwhile; if `tender.db` is lost between the comment and a failed reopen, the reopen is dropped rather than risk a second one. A marker search that returns over 100 near misses for a key fails the run instead of filing a possible duplicate. `recheckAfter` counts from the merge of `agent/<ID>`, or, for a ticket tender did not merge, from when it first saw it Done. Turning `recheck` off, or a human reopening or canceling the ticket, drops a pending recheck. Each recheck appends one `recheck` event to `tender.db`, `gone` when it closes the ticket and `still` once the reopen has landed (or the next run finds the ticket open after a reopen that reported failure),, which [`tender stats`](stats.md#columns) counts.
- **History:** each filing records an `intake-filed` event in `tender.db`.

## Judge

An opt-in LLM pass that scores shadow tickets. It is off until the host's `tender.json` has a `judge` block:

```json
"judge": { "agent": "claude", "model": "sonnet", "maxPerRun": 10 }
```

`agent` is `claude` or `codex`, `model` is required (there is no default: pick one your login can use, e.g. `sonnet` or `haiku` for Claude, `gpt-5.6-luna` for Codex), and `maxPerRun` (default 10) caps agent calls per `tender intake` run across all rules.

- **When:** inside `tender intake`, after each rule's sweep and filing, under the same lock and timer, on every run (not only when the rule is due), so tickets left over by the cap or a failed call wait 15 minutes. Nothing runs in the poll loop.
- **What it reads:** every open ticket an enabled rule filed (`intake_seen`) that is in shadow (no ready or needs-human label, read fresh from the tracker) and has no verdict: no `judge` event in `tender.db` and no comment starting `tender: judge` on the ticket. The tracker is the truth: with `tender.db` deleted, the comment stops a second call.
- **What the agent sees:** the ticket's current title and body (sanitized as at filing), the row's facts, and up to 20 other open tickets of the same rule as `{ ref, key, facts }` candidates. They go in one JSON object between `BEGIN TICKET DATA <nonce>` and `END TICKET DATA <nonce>` lines, after instructions that call it untrusted data, so ticket text can neither close the block nor pass for instructions.
- **Reply:** `{ "worth": 0-1, "fixable": 0-1, "size": "s" | "m" | "l", "duplicateOf": ref | null, "reason": "…" }`, `reason` at most 300 chars. The CLI enforces the schema and tender checks it again strictly; any other shape, a non-zero exit or a timeout (3 minutes) is logged, comments and labels nothing, and is retried next run.
- **What tender does:** posts one comment `tender: judge (<agent> <model>): worth …, fixable …, size …. <reason>` plus what it decided, records a `judge` event with the verdict, then adds labels per the rule (below). The reason is one line with `@` mentions and Linear links neutralized, and `tender:` / `tender-intake` rewritten, so it cannot pose as one of tender's lines or markers. A `duplicateOf` that is not one of the candidate refs is dropped; a valid one adds a "possible duplicate of <URL>" line and nothing else: tender never closes or relabels for it. A failed label is logged (add it by hand); a failed comment is retried with a new call next run.
- **Labels, only for a rule that opts in:** scoring alone never labels. A rule leaves shadow for the judge with `judge: { minWorth, minFixable }` (both 0-1) in `.tender/config.yaml`; its tickets get the ready label (plus `host:<host>` unless `defaultHost`) when worth ≥ `minWorth`, fixable ≥ `minFixable`, size is not `l`, and the facts' `categories` do not list `SECURITY`. Size `l` never gets the label: the comment says it is too large for an agent and needs a human to scope or split it.
- **Sandbox:** the agent runs under `nono/tender-judge.json` in a fresh `<workspaceRoot>/.intake/.judge/` dir, deleted afterwards, with no repo clone and no tools. It can write only that dir, read system paths and the agent's own install dir (the real binary, found with `mise which` or `PATH`, never a mise wrapper), and reach only its provider: Claude gets `api.anthropic.com` with the host login injected by nono's proxy as for sessions (the sandbox sees a phantom token; tender does not refresh the login itself, so keep `tender run` or another Claude use on the intake host); Codex gets `chatgpt.com` and a copy of `~/.codex-tender/auth.json` without its refresh token, as sessions do. Claude runs as `claude -p <prompt> --model <model> --system-prompt … --tools "" --strict-mcp-config --safe-mode --setting-sources "" --disable-slash-commands --no-session-persistence --output-format json --json-schema <schema>`; Codex as `codex --no-daemon exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only -C <empty dir> -m <model> --output-schema <file> -c web_search="disabled"` with its tool features (`shell_tool`, `unified_exec`, `apps`, `plugins`, `multi_agent`, `image_generation`, `browser_use`, `computer_use`, `view_image` and their siblings) disabled. Codex has no single "no tools" switch, so a tool added in a later Codex version may be on until it is listed; nono still confines it.
- **Cost:** one call per new shadow ticket (plus one per guardrail proposal), at most `maxPerRun` per run (about 10k input tokens for a Codex call, a few thousand for Claude). On a subscription it counts toward your limits. `--dry-run` makes no call and no tracker write; like the rest of a dry run it starts from an empty in-memory `tender.db`, so it finds nothing to judge.

## Guardrails

Turn each correction into a check. With `"guardrails": true` in the `judge` block, `tender intake` also asks the judge, once per merged agent PR that had feedback, for one ticket proposing a lint rule, type, test or API change that would have caught what the reviewer corrected:

```json
"judge": { "agent": "claude", "model": "sonnet", "maxPerRun": 10, "guardrails": true }
```

- **When:** inside `tender intake`, after every rule and its judging, under the same lock and timer, on every run of the whole intake (not `tender intake <rule>`). Its calls come out of the same `maxPerRun`, after the rules' judging. Nothing runs in the poll loop.
- **What it reads:** each ticket in `tender.db` with a `feedback-round` event, in a repo in `repos`, whose latest `merged` or `done` event in the last 14 days names a PR, and with no `guardrail` event for that PR. The 14-day window keeps turning guardrails on from working through all history; a PR GitHub says merged before it is recorded as skipped, and one whose merge time cannot be read is retried next run. A run examines at most 3 × `maxPerRun` PRs, failures and skips included, so failing reads cannot scan the whole window. Only sessions that ran on the intake host have events in its `tender.db`. Tender does not keep the delivered text (`<ID>.feedback` holds only a cursor and `feedback.md` goes with the worktree), so it reads it again from GitHub: the PR's reviews, comments and line comments (first 100) by the repo's `feedbackAuthors`, made up to the last recorded `feedback-round`'s time (and before the merge). That approximates what rounds delivered, with gaps: a comment edited since shows its current text, a comment landing while a round was being delivered may be in or out, and CI logs and conflict notes are left out. Plus the PR's changed file list (first 100). A PR still open waits; one closed unmerged or not an `agent/<ID>` branch is recorded as skipped; one without such comments is recorded as `propose: false` with no call.
- **What the agent sees:** the repo, PR URL, file list and up to 20 comments (each sanitized and at most 2000 chars) as one JSON object between nonce-tagged `BEGIN PULL REQUEST DATA` / `END PULL REQUEST DATA` lines, after instructions that call it untrusted data and forbid a prose rule. Same sandbox, agent and model as the judge.
- **Reply:** `{ "propose": bool, "kind": "lint" | "type" | "test" | "api" | null, "title": ≤ 120 chars | null, "body": ≤ 2000 chars | null, "reason": ≤ 300 chars }`. Another shape, a non-zero exit or a timeout is logged and retried next run.
- **Guards:** tender files nothing, whatever the prompt said, for `propose: false`, a `kind` outside the four, or a title or body naming a prose instruction file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, `copilot-instructions`, `.cursorrules`, `.cursor/rules`, `.windsurfrules`, `.clinerules`, `.tender/prompts`), after folding compatibility forms (NFKC, so fullwidth letters), dropping invisible characters and collapsing `//`, `/./` and a leading `./`. Look-alikes from other scripts (a Cyrillic А) are not caught: an accepted limit, since the ticket never gets the ready label and a human reads it. Each of these is recorded as a `guardrail` event, so the PR is never asked again.
- **Filing:** at most one ticket per PR, into the repo's tracker as [intake files](#filing), labelled `guardrail` and never with the ready label. If the source uses `guardrail` as one of its own workflow labels (ready, needs-human or, on GitHub, the in-progress, in-review or ready-to-merge label; any case), nothing is asked or filed and the run logs why. Create the `guardrail` label first, as for a rule's [labels](#labels). Title and body are sanitized like intake text (mentions and Linear links neutralized, `tender-intake` / `tender-guardrail` broken); the body opens with "Untrusted data: a guardrail proposed by tender's judge" and the PR URL, and ends with the line `tender-guardrail: <owner>/<name>#<PR>`. Before a call, tender searches the tracker for that line, so a filing whose event was never recorded (the recorder drops events under contention) is adopted instead of asked again; a lost `propose: false` costs one more call.
- **After it lands:** run [lint debt](#lint-debt) with the new rule to clear the existing copies.
- **`--dry-run`:** no call and no tracker write; like the judge, it starts from an empty `tender.db`, so it finds nothing.
