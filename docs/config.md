# Config reference

Settings in `tender.json` and in a repo's `.tender/config.yaml`. Upgrading from older layouts is in [upgrading.md](upgrading.md).

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
| `stallMinutes` | `30` | a session `working` with no transcript write for this long is parked, see [Stalled](lifecycle.md) |
| `repos` | required | allowlist array: `"owner/name"`, or `{ "name": "owner/name", …overrides }`; tickets for other repos are skipped |
| `repos[].path` | `<reposRoot>/<owner>/<name>` | an existing `tender`-only clone; never your working clone |
| `defaults` / `repos[].baseBranch` | the remote's default branch | where `.tender/` is read and PRs target |
| `defaults` / `repos[].sandbox` | required in one of them | `nono` \| `none` |
| `defaults` / `repos[].maxConcurrent` | unlimited | sessions per repo, within the global `maxConcurrent` |
| `defaults` / `repos[].maxInReview` | unlimited | no new starts in the repo while it has this many In Review plus Ready to merge tickets on this host |
| `defaults` / `repos[].autoMerge` | `off` | the ceiling for the repo's request and its `trust` rules: `off` \| `shadow` \| `intelligent` \| `all`, see [Auto-merge](auto-merge.md#auto-merge) |
| `defaults` / `repos[].criticalPaths` | `[]` | a floor of extra globs never auto-merged, added to the built-in ones and the repo's; a per-repo list replaces the `defaults` one |
| `defaults` / `repos[].feedbackAuthors` | `[]` | GitHub logins / Linear emails (case-insensitive) whose replies answer agent questions and whose PR reviews and comments go back to the session, see [Questions](lifecycle.md#questions) and [PR feedback](lifecycle.md#pr-feedback); a per-repo list replaces the `defaults` one |
| `intake.enabled` | none | `"owner/name:rule"` entries; only these [intake](intake.md) rules run |
| `intake.host` | required with `intake` | the one host that runs intake |
| `sources[].name` | required | `[a-z0-9-]`, unique |
| `sources[].tracker` | required | `github` \| `linear` |
| `readyLabel` | `agent` | ready label, GitHub and Linear |
| `needsHumanLabel` | `needs-human` | park label, GitHub and Linear; see [Parked](lifecycle.md) |
| GitHub: `inProgressLabel`, `inReviewLabel`, `readyToMergeLabel` | `in-progress`, `in-review`, `ready-to-merge` | done = issue closed, unless as not planned or duplicate (canceled) |
| Linear: `team`, `todo`, `inProgress`, `inReview`, `readyToMerge`, `done` | —, `Todo`, `In Progress`, `In Review`, unset, `[Done]` | `team` is the key, e.g. `ENG`; `readyToMerge` unset keeps tickets In Review; a Canceled- or Duplicate-type state is canceled even if listed in `done` |

A source key its tracker does not use (e.g. `team` on a GitHub source, `inProgressLabel` on a Linear one) is rejected at startup. `agent`, `testCmd`, `planStep`, `prompt` and `testPaths` are rejected with `<key>: moved to .tender/config.yaml in the repo`.

## Repo config

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
trust:
  - { paths: ["docs/**", "**/*.md"], autoMerge: all }
  - { paths: ["supabase/migrations/**"], autoMerge: off }
escapeHatches: ["pragma: no cover"]
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
| `criticalPaths` | `[]` | globs added to the built-in critical paths, `.tender/**` and the host's `criticalPaths`, see [Auto-merge](auto-merge.md#auto-merge) |
| `testPaths` | `[]` | globs added to the built-in test paths |
| `trust` | `[]` | `{ paths: [glob, …], autoMerge }` rules: a changed file takes the mode of the first rule matching it, else `autoMerge`; see [Auto-merge](auto-merge.md#auto-merge) |
| `escapeHatches` | `[]` | up to 20 regexes (at most 200 chars each) for added lines that hold a merge back, on top of the built-in ones |
| `prompts.default` | `default.md` if present | a file in `.tender/prompts/` |
| `prompts.byLabel` | `{}` | ticket label to prompt file; the first entry whose label the ticket has wins, else `prompts.default` |
| `tracker.linear.project` | none | the Linear project whose tickets come here when they name no repo themselves, see [Which repo a ticket goes to](lifecycle.md#which-repo-a-ticket-goes-to) |
| `tracker.linear.team` | none | a Linear team key, only checked: a ticket routed here from another team's source is logged once |
| `intake` | `[]` | up to 20 [intake](intake.md) rules: `name`, `run` (required), `every` (`1h`), `maxPerRun` (`3`, at most 20), `secrets` (`[]`), `network` (`[]`), `autoLabel` (`[]`), `recheck` (`true`), `recheckAfter` (`24h`); each runs only when `tender.json` enables it |

`tender` reads `.tender/` only from `origin/<base>` in its own clone (`git ls-tree` and `git cat-file` on that commit, fetched before each start and once per poll before merge decisions or Linear project routing), never from a session clone, which the agent can write. A repo's config changes only when a commit to the base branch changes it; it is cached per base commit. Each file must be a regular file of at most 64 KiB, prompt files must be named `[a-z0-9-]+.md`, and unknown keys are errors. If it is invalid, that repo starts no tickets: `tender` logs the errors once per base commit and posts one `tender: not started` comment per base commit on the next ticket that names that repo and would have started (recorded in `<workspaceRoot>/.invalid-config/<owner>/<name>`). Meanwhile Linear tickets that rely on their project wait, with no comment. `.tender` itself must be a directory, not a symlink. Run `bun tender.ts check [path]` (default `.`) before committing: it validates `<path>/.tender/` from the working tree, prints the repo's settings with defaults filled in (the host's `autoMerge` ceiling and `criticalPaths` from `tender.json` still apply on top) and its tracker target (`tracker`, `null` if none), and exits non-zero if it is invalid.

Prompt placeholders: `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{testCmd}} {{tests}} {{repo}} {{planStep}}`. `{{tests}}` is `` `<testCmd>` ``, or "the project's tests (…)" when `testCmd` is unset; `{{testCmd}}` is then empty.

CLI: `bun tender.ts <run|once|status|watch|tail|check|open|resume|intake> [path|ID|rule] [--dry-run] [--json] [--interval s] [--plain] [-n N] [--no-follow] [--tool t] [--exec] [--config tender.json]`.
