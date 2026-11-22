---
name: tender-setup
description: Set up a repo for tender. Finds its test command, writes .tender/config.yaml and .tender/verify.yaml, validates it with tender check, and prints the tender.json repos entry. Use when the user asks to set up, onboard or configure a repo for tender.
---

# tender setup

Work in the root of the repo being set up. Write only under `.tender/`. Never edit `tender.json`, `.env` or anything outside this repo. Ask the user for the path to their tender clone, the directory that holds `tender.ts`. It is called `<tender>` below.

tender reads `.tender/` only from `origin/<base branch>`, so nothing takes effect until it is committed and pushed there. The keys and their validation live in tender's `src/config/repo-config.ts`; `docs/config.md` documents them under "Repo config".

## 1. Find the test command

Check, in order:

- `package.json` `scripts`: `test`, plus `typecheck` or `lint` if they are fast. Run them with the package manager that matches the lockfile: `bun.lock*` means `bun run`, `pnpm-lock.yaml` means `pnpm`, `yarn.lock` means `yarn`, and anything else means `npm run`.
- `Makefile`: a `test` target, so `make test`.
- `pyproject.toml`: `pytest`, or `uv run pytest` if there is a `uv.lock`.
- `go.mod`: `go test ./...`.
- `Cargo.toml`: `cargo test`.

Show the command to the user and confirm it. Each command becomes a check in `.tender/verify.yaml` (step 3). If nothing fits, write no `verify.yaml`: the agent will be told to find and run the project's checks, and medium and large changes never auto-merge.

## 2. Ask the user

- **Agent:** `claude` (the default) or `codex`, optionally with a model and effort: `agent: { name: claude, model: sonnet, effort: high }`. Quote a model with brackets: `model: "opus[1m]"`. Effort is `low`, `medium`, `high`, `xhigh` or `max` for Claude, `minimal`, `low`, `medium`, `high` or `xhigh` for Codex.
- **Linear project:** the name of the project whose tickets should come to this repo, if any, and optionally its team key (for example `ENG`). Skip this for GitHub issues, which go to their own repo.
- **Auto-merge:** suggest `shadow`, which posts what it would merge and never merges, or `off`. Use `intelligent` or `all` only if the user asks for it. The host's `autoMerge` for this repo in `tender.json` (default `off`) is a ceiling, and the lower of the two applies (`off < shadow < intelligent < all`).
- **Task types:** only if the user wants them. Without them, tender uses the host profile's types (tender ships `bug`, `docs` and `default` in `<tender>/profile/`).

## 3. Write `.tender/config.yaml` and `.tender/verify.yaml`

Write only the keys that differ from the defaults. An unknown key fails the check.

```yaml
agent: claude
autoMerge: shadow
tracker:
  linear:
    project: Web app   # Linear project name; matched case-insensitively
    team: ENG          # optional; a team key, [A-Z0-9]+
```

`.tender/verify.yaml` holds the test command from step 1, one check per command; `docs/config.md` documents it under "Verify contract":

```yaml
checks:
  - name: test
    run: bun test
  - name: typecheck
    run: bun run typecheck
```

Add these keys only if the user asks for them:

- `criticalPaths`: globs added to the built-in critical paths and the host's `criticalPaths`. A critical path is never auto-merged, in any mode.
- `testPaths`: globs added to the built-in test paths. Under `intelligent`, a PR that deletes, renames or removes lines from an existing test file is not merged.
- `trust`: a list of `{ paths: [glob, …], autoMerge: <mode> }`. The first rule that matches a file decides its mode, and the host ceiling still caps it.
- `escapeHatches`: up to 20 regexes of at most 200 characters each, for added lines that block a merge.
- `intake`: rules that file tickets from errors, database advisors and the like. Leave them out here; once the repo is set up, the `tender-maintain` skill suggests the ones it qualifies for.

tender's prompt header and closing protocol are fixed; the type's instruction file goes between them. Under `types`, a repo adds a type or replaces the profile's type of the same name; `instructions` names a `.md` file in the host's profile, never one in the repo, and the type's `agent` replaces the repo's whole `agent`, model and effort included. If an instruction file names a skill, the session's agent must have it: committed in the repo (`.claude/skills/` for Claude, `.agents/skills/` for Codex) or installed for the user. Use block style, since a comma ends plain text inside `{ … }`:

```yaml
types:
  - name: bug
    match:
      labels: ["type:bug"]
    instructions: instructions/bug.md
    agent: { name: codex, effort: xhigh }
```

The placeholders are `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{verify}} {{repo}}`.

## 4. Validate

Run `bun <tender>/tender.ts check .` from the root of the repo being set up; add `--config <tender.json>` when its `types` name files in a profile other than tender's own. tender installs no `tender` command.

The check prints the settings with defaults filled in, or lists every problem and exits non-zero. Fix the problems and run it again until it passes. The check does not apply the host ceiling or the host's `criticalPaths`.

## 5. Hand off

Get `owner/name` from `git remote get-url origin`, and print the entry for the user to add to `repos` in `tender.json`:

- `"owner/name"`, which takes the host's `defaults`; or
- `{ "name": "owner/name", "autoMerge": "<mode>" }`, with the mode chosen in step 2, to set this repo's ceiling to that mode.

Then tell the user to commit `.tender/` and push it to the base branch, through a PR if the branch is protected. tender never auto-merges changes to `.tender/**`.
