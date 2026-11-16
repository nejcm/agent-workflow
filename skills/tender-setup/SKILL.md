---
name: tender-setup
description: Set up a repo for tender. Finds its test command, writes .tender/config.yaml, validates it with tender check, and prints the tender.json repos entry. Use when the user asks to set up, onboard or configure a repo for tender.
---

# tender setup

Work in the root of the repo being set up. Write only under `.tender/`. Never edit `tender.json`, `.env` or anything outside this repo. Ask the user for the path to their tender clone, the directory that holds `tender.ts`. It is called `<tender>` below.

tender reads `.tender/` only from `origin/<base branch>`, so nothing takes effect until it is committed and pushed there. The keys and their validation live in tender's `src/repo-config.ts`; its README documents them under "Repo config".

## 1. Find the test command

Check, in order:

- `package.json` `scripts`: `test`, plus `typecheck` or `lint` if they are fast. Run them with the package manager that matches the lockfile: `bun.lock*` means `bun run`, `pnpm-lock.yaml` means `pnpm`, `yarn.lock` means `yarn`, and anything else means `npm run`.
- `Makefile`: a `test` target, so `make test`.
- `pyproject.toml`: `pytest`, or `uv run pytest` if there is a `uv.lock`.
- `go.mod`: `go test ./...`.
- `Cargo.toml`: `cargo test`.

Show the command to the user and confirm it. Chain several with `&&`. If nothing fits, leave `testCmd` unset, and the agent will be told to find and run the project's tests.

## 2. Ask the user

- **Agent:** `claude` (the default) or `codex`.
- **Linear project:** the name of the project whose tickets should come to this repo, if any, and optionally its team key (for example `ENG`). Skip this for GitHub issues, which go to their own repo.
- **Auto-merge:** suggest `shadow`, which posts what it would merge and never merges, or `off`. Use `intelligent` or `all` only if the user asks for it. The host's `autoMerge` for this repo in `tender.json` (default `off`) is a ceiling, and the lower of the two applies (`off < shadow < intelligent < all`).
- **Custom prompt:** only if the user wants one. Without it, tender uses `<tender>/prompts/default.md`.

## 3. Write `.tender/config.yaml`

Write only the keys that differ from the defaults. An unknown key fails the check.

```yaml
agent: claude
testCmd: bun test && bun run typecheck
autoMerge: shadow
tracker:
  linear:
    project: Web app   # Linear project name; matched case-insensitively
    team: ENG          # optional; a team key, [A-Z0-9]+
```

Add these keys only if the user asks for them:

- `planStep`: step 2 of the prompt (default `Plan and implement the ticket.`). If it names a skill, that skill must be installed in `~/.claude/skills`.
- `criticalPaths`: globs added to the built-in critical paths and the host's `criticalPaths`. A critical path is never auto-merged, in any mode.
- `testPaths`: globs added to the built-in test paths. Under `intelligent`, a PR that deletes, renames or removes lines from an existing test file is not merged.
- `trust`: a list of `{ paths: [glob, …], autoMerge: <mode> }`. The first rule that matches a file decides its mode, and the host ceiling still caps it.
- `escapeHatches`: up to 20 regexes of at most 200 characters each, for added lines that block a merge.

For a custom prompt, copy `<tender>/prompts/default.md` to `.tender/prompts/default.md` and edit it. tender picks the file up without any config key. Prompt files must be named `[a-z0-9-]+.md`. To choose a prompt by ticket label, add `prompts: { byLabel: { "type:bug": bug.md } }`. The placeholders are `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{testCmd}} {{tests}} {{repo}} {{planStep}}`.

## 4. Validate

Run `bun <tender>/tender.ts check .` from the root of the repo being set up. tender installs no `tender` command.

The check prints the settings with defaults filled in, or lists every problem and exits non-zero. Fix the problems and run it again until it passes. The check does not apply the host ceiling or the host's `criticalPaths`.

## 5. Hand off

Get `owner/name` from `git remote get-url origin`, and print the entry for the user to add to `repos` in `tender.json`:

- `"owner/name"`, which takes the host's `defaults`; or
- `{ "name": "owner/name", "autoMerge": "<mode>" }`, with the mode chosen in step 2, to set this repo's ceiling to that mode.

Then tell the user to commit `.tender/` and push it to the base branch, through a PR if the branch is protected. tender never auto-merges changes to `.tender/**`.
