# Config reference

Every setting tender reads, with its type, allowed values and default:

- [Host config](#host-config) (`tender.json`): this machine, which repos it may work on, which trackers it polls.
- [Repo config](#repo-config) (`.tender/config.yaml`): how the agent works on one repo; committed to that repo.
- [Environment](#environment) and [CLI](#cli).

Unknown keys are errors in both files. Upgrading from older layouts is in [upgrading.md](upgrading.md).

## Host config

`tender.json`, read from the working directory or `--config <path>`. Relative paths resolve against the file's directory, and `~` is your home. A full example is [`tender.example.json`](../tender.example.json).

```json
{
  "host": "laptop",
  "defaultHost": true,
  "maxConcurrent": 2,
  "defaults": { "sandbox": "nono", "autoMerge": "off" },
  "repos": ["acme/web", { "name": "acme/api", "autoMerge": "intelligent", "feedbackAuthors": ["octocat"] }],
  "sources": [
    { "name": "gh", "tracker": "github" },
    { "name": "eng", "tracker": "linear", "team": "ENG", "readyToMerge": "Ready to merge" }
  ],
  "intake": { "enabled": ["acme/web:sentry-web"], "host": "laptop" }
}
```

### Top level

| key | type | default | |
|---|---|---|---|
| `host` | string `[A-Za-z0-9._-]` | required | this machine's name; it takes tickets labeled `host:<host>` |
| `defaultHost` | boolean | `false` | also take tickets with no `host:` label (never other hosts') |
| `pollIntervalMs` | integer ≥ 5000 | `60000` | time between tracker polls |
| `workspaceRoot` | path | `~/agent-ws` | session clones (`<owner>/<name>/<ID>`), prompts, launchers, sidecars, `tender.db`, intake state |
| `reposRoot` | path | `~/agent-repos` | `tender`-managed clones (`<owner>/<name>`), cloned when `run` or `once` starts |
| `tmuxSession` | string `[a-z0-9-]`, ≤ 32 | `tender` | tmux session that holds the agent windows |
| `maxConcurrent` | positive integer | `2` | running sessions in total |
| `maxInReview` | positive integer | unlimited | no new starts while this host has this many In Review plus Ready to merge tickets |
| `stallMinutes` | positive integer | `30` | a session `working` with no transcript write for this long is parked, see [Stalled](lifecycle.md) |
| `defaults` | object | `{}` | per-repo settings applied to every entry in `repos` (no `path`) |
| `repos` | non-empty array | required | the allowlist; tickets for any other repo are skipped |
| `sources` | non-empty array | required | the trackers to poll |
| `intake` | object | none | which [intake](intake.md) rules run, and where |
| `judge` | object | none | turns on the [judge](intake.md#judge) for intake tickets and, opt-in, [guardrails](intake.md#guardrails); needs `intake` |
| `prs` | object | `{ "staleDays": 14 }` | the [PR sweep](prs.md) |
| `githubApp` | object | none | act on GitHub as a GitHub App instead of your `gh` login, see [GitHub App](setup.md#github-app) |

### `repos` and `defaults`

A `repos` entry is `"owner/name"` or `{ "name": "owner/name", …settings }`. Each setting below can sit in `defaults` or on the entry; the entry wins, and for lists it replaces the `defaults` list instead of extending it. Names are unique ignoring case.

| key | type | default | |
|---|---|---|---|
| `path` | path (entry only) | `<reposRoot>/<owner>/<name>` | an existing `tender`-only clone; never your working clone |
| `baseBranch` | branch name | the remote's default branch | where `.tender/` is read and PRs target |
| `sandbox` | `nono` \| `none` | required in the entry or `defaults` | see [Sandbox](sandbox.md) |
| `maxConcurrent` | positive integer | unlimited | sessions for this repo, within the global `maxConcurrent` |
| `maxInReview` | positive integer | unlimited | no new starts in the repo while it has this many In Review plus Ready to merge tickets on this host |
| `autoMerge` | `off` \| `shadow` \| `intelligent` \| `all` | `off` | the ceiling for the repo's own `autoMerge` and `trust` rules, see [Auto-merge](auto-merge.md#auto-merge) |
| `criticalPaths` | array of globs | `[]` | a floor of paths never auto-merged, added to the built-in and the repo's own |
| `feedbackAuthors` | array of strings | `[]` | GitHub logins / Linear emails (case-insensitive) whose replies answer agent questions and whose PR reviews and comments go back to the session, see [Questions](lifecycle.md#questions) and [PR feedback](lifecycle.md#pr-feedback) |

`agent`, `testCmd`, `planStep`, `prompt` and `testPaths` are rejected here with `<key>: moved to .tender/config.yaml in the repo`.

### `sources`

Keys every source has:

| key | type | default | |
|---|---|---|---|
| `name` | string `[a-z0-9-]`, ≤ 32, unique | required | |
| `tracker` | `github` \| `linear` | required | |
| `readyLabel` | string | `agent` | the label that hands a ticket to tender |
| `needsHumanLabel` | string | `needs-human` | the park label, see [Parked](lifecycle.md) |

A GitHub source polls every repo in `repos` and tracks status with labels. A ticket is done when the issue is closed, unless it was closed as not planned or duplicate, which counts as canceled.

| key | default |
|---|---|
| `inProgressLabel` | `in-progress` |
| `inReviewLabel` | `in-review` |
| `readyToMergeLabel` | `ready-to-merge` |

A Linear source polls one team and tracks status with workflow states:

| key | type | default | |
|---|---|---|---|
| `team` | team key `[A-Z0-9]+` | required | e.g. `ENG` |
| `todo` | state name | `Todo` | |
| `inProgress` | state name | `In Progress` | |
| `inReview` | state name | `In Review` | |
| `readyToMerge` | state name | unset | unset keeps tickets In Review, see [Ready to merge](lifecycle.md#ready-to-merge) |
| `done` | non-empty array of state names | `["Done"]` | a Canceled- or Duplicate-type state counts as canceled even if listed here |

A key the source's tracker doesn't use (e.g. `team` on a GitHub source) is rejected at startup.

### `intake`

| key | type | default | |
|---|---|---|---|
| `intake.enabled` | array of `"owner/name:rule"` | required with `intake` | only these repo rules run; the repo must be in `repos` |
| `intake.host` | string | required with `intake` | the one host that runs intake; on any other host `tender intake` does nothing |

### `judge`

| key | type | default | |
|---|---|---|---|
| `judge.agent` | `"claude"` \| `"codex"` | required with `judge` | the CLI that scores shadow intake tickets, see [Judge](intake.md#judge) |
| `judge.model` | string | required with `judge` | the model name passed to `--model` / `-m`; no default |
| `judge.maxPerRun` | integer 1–100 | `10` | agent calls per `tender intake` run, across all rules and guardrails |
| `judge.guardrails` | boolean | `false` | also proposes one [guardrail](intake.md#guardrails) ticket per merged agent PR that had feedback |

### `prs`

| key | type | default | |
|---|---|---|---|
| `prs.staleDays` | integer 1–365 | `14` | a PR with no update for this many days is `stale` (`draft-stale` for a draft); a clean PR older than this is `ready` |
| `prs.digestIssue` | `"owner/name#<n>"` | none | a GitHub issue, in a repo in `repos`, whose body `tender prs` replaces with its report on each run |

### `githubApp`

| key | type | default | |
|---|---|---|---|
| `githubApp.appId` | positive integer | required with `githubApp` | the App's ID |
| `githubApp.installationId` | positive integer | required with `githubApp` | the installation on the account that owns every repo in `repos` |
| `githubApp.privateKeyFile` | path | required with `githubApp` | the App's private key (`.pem`, PKCS#1 or PKCS#8); never the key itself; keep it mode 600 |

With `githubApp` set, every repo in `repos` must have the same owner, there may be at most 500 (GitHub's limit per token), and every repo needs `sandbox: "nono"`.

## Repo config

`.tender/config.yaml`: how the agent works on a repo lives in the repo itself:

```
.tender/
  config.yaml        # optional
  prompts/
    default.md       # optional; else tender's prompts/default.md
    bug.md           # chosen by ticket label
  intake/            # intake scripts, if any
  run/               # the agent's scratch dir, git-ignored by its own .gitignore
```

```yaml
agent: claude
testCmd: bun test
planStep: Load the `orchestration` skill and use it to plan and implement the ticket.
autoMerge: intelligent
criticalPaths: ["src/billing/**"]
testPaths: ["spec/**"]
trust:
  - { paths: ["docs/**", "**/*.md"], autoMerge: all }
  - { paths: ["supabase/migrations/**"], autoMerge: off }
escapeHatches: ["pragma: no cover"]
prompts:
  default: default.md
  byLabel:
    "type:bug": bug.md
tracker:
  linear:
    project: Web app
    team: ENG
intake:
  - name: sentry-web
    run: .tender/intake/sentry.ts
    args: [--org, acme, --project, web]
    secrets: [SENTRY_TOKEN]
    network: [sentry.io]
    labels: [sentry]
```

| key | type | default | |
|---|---|---|---|
| `agent` | `claude` \| `codex` | `claude` | which agent CLI the session runs |
| `testCmd` | string | none | the agent must pass it before opening a PR; unset, the prompt tells it to find and run the project's tests |
| `planStep` | string | `Plan and implement the ticket.` | step 2 of the default prompt |
| `autoMerge` | `off` \| `shadow` \| `intelligent` \| `all` | the host's | the repo's request; the effective mode is the lower of it and the host's `autoMerge` (`off < shadow < intelligent < all`) |
| `criticalPaths` | list of globs | `[]` | added to the built-in critical paths, `.tender/**` and the host's `criticalPaths`, see [Auto-merge](auto-merge.md#auto-merge) |
| `testPaths` | list of globs | `[]` | added to the built-in test paths |
| `trust` | list of `{ paths: [glob, …], autoMerge }` | `[]` | a changed file takes the mode of the first rule matching it, else `autoMerge`; capped by the host's `autoMerge` |
| `escapeHatches` | list of regexes, ≤ 20, each ≤ 200 chars | `[]` | added lines matching one hold a merge back, on top of the built-in ones |
| `prompts.default` | file in `.tender/prompts/` | `default.md` if present, else tender's | |
| `prompts.byLabel` | map of label to prompt file | `{}` | the first entry whose label the ticket has wins, else `prompts.default` |
| `tracker.linear.project` | Linear project name | none | the project whose tickets come here when they name no repo themselves, see [Which repo a ticket goes to](lifecycle.md#which-repo-a-ticket-goes-to) |
| `tracker.linear.team` | team key `[A-Z0-9]+` | none | only checked: a ticket routed here from another team's source is logged once |
| `intake` | list of rules, ≤ 20 | `[]` | see below |

### Intake rules

Each entry of `intake` is one rule. A rule runs only when `tender.json` lists it in `intake.enabled`. Durations are `<n>m`, `<n>h` or `<n>d`, with `n` from 1 to 9999.

| key | type | default | |
|---|---|---|---|
| `name` | string `[a-z0-9-]`, ≤ 32, unique in the repo | required | enabled as `owner/name:<name>` |
| `run` | path inside the repo | required | the executable script, e.g. `.tender/intake/sentry.ts` |
| `args` | list of strings, ≤ 20, each ≤ 200 chars, no control characters | `[]` | passed to `run` as argv on collect and `--recheck`, never through a shell |
| `every` | duration | `1h` | minimum time between collects, rounded to the 15-minute timer |
| `maxPerRun` | integer 1–20 | `3` | new tickets filed per collect |
| `secrets` | list of env var names `[A-Z][A-Z0-9_]*` | `[]` | read from the host's environment (`.env`) and passed to the script; tender's own (`GH_*`, `GITHUB_*`, `LINEAR_*`, `TENDER_*`, `NONO_*`, `CLAUDE_*`, `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*`, `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`, `TMP`, `TEMP`) are refused |
| `network` | list of lowercase host names | `[]` | the only hosts the script may reach; empty means no network |
| `loopback` | boolean | `false` | run the script in its own network namespace whose loopback it may use, for tunneling non-HTTP clients like Postgres through the `network` proxy, see [Sandbox](intake.md#sandbox) |
| `private` | boolean | `false` | file only for a private GitHub repo, whatever the tracker (the fix PR lands there): a public repo fails the run, see [Filing](intake.md#filing) |
| `labels` | list of label names, ≤ 5, each ≤ 50 chars, no commas or colons | `[]` | added to every ticket the rule files, shadow or not; the source's own labels (ready, needs-human, status) are refused at run time, see [Labels](intake.md#labels) |
| `autoLabel` | list of `{ fact: value, min<Fact>: number }` | `[]` | a ticket gets the ready label when every condition of any rule holds (`min<Fact>` is `facts.<fact> >= n`, other keys are equality); no match files a shadow ticket; a finding whose `categories` fact lists `SECURITY` never matches, and a rule naming `SECURITY` there is rejected |
| `recheck` | boolean | `true` | after the ticket is Done, ask the script whether the problem is gone; reopen once if not |
| `recheckAfter` | duration | `24h` | how long after Done the recheck runs |
| `judge` | `{ minWorth, minFixable }`, both numbers 0–1 | none | lets the [judge](intake.md#judge) add the ready label when both scores reach these floors, size is not `l` and there is no `SECURITY` fact; without it the judge only scores and comments |

The script's flags (e.g. the Sentry script's `--org`, `--min-events`, `--no-fixes`, the Postgres scripts' `--min-mean-ms`) are listed with each [example script](intake.md#example-scripts). The output protocol is in [Script protocol](intake.md#script-protocol).

### How the repo config is read

`tender` reads `.tender/` only from `origin/<base>` in its own clone (`git ls-tree` and `git cat-file` on that commit, fetched before each start and once per poll before merge decisions or Linear project routing), never from a session clone, which the agent can write. A repo's config changes only when a commit to the base branch changes it; it is cached per base commit. Each file must be a regular file of at most 64 KiB, prompt files must be named `[a-z0-9-]+.md`, and unknown keys are errors. If it is invalid, that repo starts no tickets: `tender` logs the errors once per base commit and posts one `tender: not started` comment per base commit on the next ticket that names that repo and would have started (recorded in `<workspaceRoot>/.invalid-config/<owner>/<name>`). Meanwhile Linear tickets that rely on their project wait, with no comment. `.tender` itself must be a directory, not a symlink. Run `bun tender.ts check [path]` (default `.`) before committing: it validates `<path>/.tender/` from the working tree, prints the repo's settings with defaults filled in (the host's `autoMerge` ceiling and `criticalPaths` from `tender.json` still apply on top) and its tracker target (`tracker`, `null` if none), and exits non-zero if it is invalid.

### Prompt placeholders

`{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{testCmd}} {{tests}} {{repo}} {{planStep}}`. `{{tests}}` is `` `<testCmd>` ``, or "the project's tests (…)" when `testCmd` is unset; `{{testCmd}}` is then empty.

## Environment

| variable | where | |
|---|---|---|
| `LINEAR_API_KEY` | `.env` in tender's working directory | required with a Linear source, see [Auth](auth.md) |
| intake `secrets` (e.g. `SENTRY_TOKEN`, `PG_INTAKE_URL`) | `.env` | passed only to the rules that declare them |

GitHub uses `gh`'s own login; see [Auth](auth.md).

## CLI

```
bun tender.ts <command> [--config tender.json]
  run | once [--dry-run]
  status [--json]
  watch [--interval 2] [--plain]
  tail <ID | owner/repo/ID> [-n 20] [--no-follow]
  open <ID | owner/repo/ID> [--tool claude|codex|t3|editor] [--exec]
  resume <ID | owner/repo/ID>
  intake [owner/repo:rule | rule] [--dry-run]
  check [path]
```

| flag | | |
|---|---|---|
| `--config` | path | host config, default `./tender.json` |
| `--dry-run` | `run`, `once`, `intake` | log what would happen; files, comments and writes nothing to trackers or `tender.db` |
| `--json` | `status` | machine-readable output |
| `--interval` | `watch`, seconds ≥ 1 | refresh interval, default `2` |
| `--plain` | `watch` | plain text instead of the TUI |
| `-n` | `tail`, 1–10000 | lines of history, default `20` |
| `--no-follow` | `tail` | print and exit |
| `--tool` | `open` | where to open the session, see [Hand-off](hand-off.md) |
| `--exec` | `open` | run the command instead of printing it |
