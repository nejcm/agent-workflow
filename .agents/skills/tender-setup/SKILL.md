---
name: tender-setup
description: Set up a repo for tender. Checks that CI gates its PRs, writes .tender/config.yaml and type overrides, validates them with tender check, offers create-verification when installed, and prints the tender.json repos entry. Use when the user asks to set up, onboard or configure a repo for tender.
---

# tender setup

Work in the root of the repo being set up. Write only under `.tender/`; the `create-verification` hand-off in step 6 writes its own files. Never edit `tender.json`, `.env` or anything outside this repo. Ask the user for the path to their tender clone, the directory that holds `tender.ts`, and to their `tender.json`. They are called `<tender>` and `<tender.json>` below.

tender reads `.tender/` only from `origin/<base branch>`, so nothing takes effect until it is committed and pushed there. The keys and their validation live in tender's `src/config/repo-config.ts`; `docs/config.md` documents them under "Repo config".

## 1. Check CI

tender runs no tests itself: CI gates every merge, and a medium or large change auto-merges only with at least one CI status check on the PR. Find what runs on pull requests (`.github/workflows/*.yml` with a `pull_request` trigger, or the repo's other CI config) and tell the user which checks gate a PR. If none does, say that medium and large changes will never auto-merge until CI reports a check.

## 2. Ask the user

- **Agent:** `claude` (the default) or `codex`, optionally with a model and effort: `agent: { name: claude, model: sonnet, effort: high }`. Quote a model with brackets: `model: "opus[1m]"`. Effort is `low`, `medium`, `high`, `xhigh` or `max` for Claude, `minimal`, `low`, `medium`, `high` or `xhigh` for Codex.
- **Linear project:** the name of the project whose tickets should come to this repo, if any, and optionally its team key (for example `ENG`). Skip this for GitHub issues, which go to their own repo.
- **Auto-merge:** suggest `shadow`, which posts what it would merge and never merges, or `off`. Use `intelligent` or `all` only if the user asks for it. The host's `autoMerge` for this repo in `tender.json` (default `off`) is a ceiling, and the lower of the two applies (`off < shadow < intelligent < all`).

## 3. Find type overrides

Without `types`, tender uses the host profile's types (the `profile` in `<tender.json>`, else tender's own `<tender>/profile/` with `bug`, `docs` and `default`). Read the profile's `types.yaml` and propose an override, under the same name, only where the repo gives evidence for one:

- **Labels:** `gh label list` shows the repo marks bugs or docs with a label the profile type does not match (`bug`, `documentation`): replace that type with `match.labels` holding the repo's label and the profile's own.
- **Ports and services:** the app serves something a session has to start to check its work (a dev server, an API), or needs a database it brings up with a Compose file: give `default` and `bug` `needs: { ports: <n> }`, and `compose: <file>` when there is one, so the session gets `TENDER_PORT_0…` and tender starts the services.
- **Agent:** the user wants one type on another agent or effort.

Show each to the user and write only those they keep.

## 4. Write `.tender/config.yaml`

Write only the keys that differ from the defaults. An unknown key fails the check.

```yaml
agent: claude
autoMerge: shadow
tracker:
  linear:
    project: Web app   # Linear project name; matched case-insensitively
    team: ENG          # optional; a team key, [A-Z0-9]+
```

Add these keys only if the user asks for them:

- `criticalPaths`: globs added to the built-in critical paths and the host's `criticalPaths`. A critical path is never auto-merged, in any mode.
- `testPaths`: globs added to the built-in test paths. Under `intelligent`, a PR that deletes, renames or removes lines from an existing test file is not merged.
- `trust`: a list of `{ paths: [glob, …], autoMerge: <mode> }`. The first rule that matches a file decides its mode, and the host ceiling still caps it.
- `escapeHatches`: up to 20 regexes of at most 200 characters each, for added lines that block a merge.
- `intake`: rules that file tickets from errors, database advisors and the like. Leave them out here; once the repo is set up, the `tender-maintain` skill suggests the ones it qualifies for.

tender's prompt header and closing protocol are fixed; the type's instruction file goes between them. The type overrides from step 3 go under `types`: a repo adds a type or replaces the profile's type of the same name, whole, so copy its `instructions` and `match`; `instructions` names a `.md` file in the host's profile, never one in the repo, and the type's `agent` replaces the repo's whole `agent`, model and effort included. If an instruction file names a skill, the session's agent must have it: committed in the repo (`.claude/skills/` for Claude, `.agents/skills/` for Codex) or installed for the user. Use block style, since a comma ends plain text inside `{ … }`:

```yaml
types:
  - name: bug
    match:
      labels: ["type:bug"]
    instructions: instructions/bug.md
    agent: { name: codex, effort: xhigh }
  - name: default
    instructions: instructions/default.md
    needs: { ports: 1 }
```

The placeholders are `{{id}} {{title}} {{body}} {{url}} {{branch}} {{base}} {{verify}} {{repo}}`.

## 5. Validate

Run `bun <tender>/tender.ts check . --config <tender.json>` from the root of the repo being set up, so `types` are checked against the host's profile. tender installs no `tender` command.

The check prints the settings with defaults filled in, or lists every problem and exits non-zero. Fix the problems and run it again until it passes. The check does not apply the host ceiling or the host's `criticalPaths`.

## 6. Hand off

If the repo has no verification skill (`.agents/skills/verify-*/` or `.claude/skills/*verif*/`) and a surface to drive (a web app, an API, a CLI), say that sessions would use one. If the `create-verification` skill is available to you (in your skills list, or under `~/.claude/skills/`, `~/.agents/skills/` or this repo's `.agents/skills/`), offer to hand off to it; it is optional, and tender works without it.

Get `owner/name` from `git remote get-url origin`, and print the entry for the user to add to `repos` in `tender.json`:

- `"owner/name"`, which takes the host's `defaults`; or
- `{ "name": "owner/name", "autoMerge": "<mode>" }`, with the mode chosen in step 2, to set this repo's ceiling to that mode.

Then tell the user to commit `.tender/` (and `.agents/skills/verify-*/`, if written) and push it to the base branch, through a PR if the branch is protected. tender never auto-merges changes to `.tender/**`.
