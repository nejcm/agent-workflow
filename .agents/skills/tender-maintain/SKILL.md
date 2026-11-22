---
name: tender-maintain
description: Maintain a repo's tender setup. Proposes repairs for what tender's contract check reports in .tender/config.yaml, for verify checks that no longer pass on the base branch, and suggests intake rules the repo now qualifies for. Use when the user asks to maintain, repair, update or review a repo's tender config, or acts on a "tender contract" ticket.
---

# tender maintain

Work in the root of a repo that already has `.tender/`; for a repo without one, use the `tender-setup` skill. This skill proposes and never applies: it edits nothing in the repo; only `tender verify` writes, in tender's own workspace. Ask the user for the path to their tender clone, the directory that holds `tender.ts`, and to their `tender.json`. They are called `<tender>` and `<tender.json>` below.

Show each proposed change as a diff or a YAML block for the user to apply. tender reads `.tender/` only from `origin/<base branch>`, so nothing takes effect until it is committed and pushed there.

## 1. Check the contract

Run `TENDER_CONFIG=<tender.json> bun <tender>/intake/contract.ts` from the repo root, with the user's `tender.json` so the check uses this repo's profile (without it, tender's own `profile/`). It prints one JSON line per broken item and nothing when all is well; a non-zero exit is a failed run, not a finding. A `tender contract` ticket names the same `key`.

- `contract:config:check`: `.tender/` fails `bun <tender>/tender.ts check . --config <tender.json>`, so tender starts no tickets here. Propose a fix for each listed problem; the keys are documented in `<tender>/docs/config.md` under "Repo config". Unknown-key errors for `testCmd`, `prompt` or `byLabel` mean config from before task types: move the test command into `.tender/verify.yaml` and per-label prompts into `types`, as `<tender>/docs/config.md` describes.
- `contract:criticalPaths:…` or `contract:trust:…`: the glob in the item's `glob` fact matches no file in `git ls-files`. Find where the files went (`git log --stat -1 -- <old path>` shows the commit that moved or removed them), and propose the new glob or removing it. Never widen a glob to make it match.

Then, if the base branch has a `.tender/verify.yaml` (`git show origin/<base>:.tender/verify.yaml`), confirm every check still runs on base: run `bun <tender>/tender.ts verify <owner/name> --config <tender.json>`, with `owner/name` from `git remote get-url origin`. It runs the contract on the base commit through tender's own verifier and sandbox, the way every PR is checked, never ad hoc in this shell. Exit 0 means every check passed. Otherwise it names the failed check and prints its output tail, or prints why it could not run (repo not in `tender.json`, no nono); a check that fails on base fails on every PR too, so nothing with a contract merges. Find the cause in the output (a moved script, a renamed package script, a dependency the offline clone lacks, a timeout) and propose the smallest fix to the check or to the code it runs. Never weaken a check to make it pass: dropping it, skipping tests, or `|| true`.

After the user applies the fixes and pushes them to the base branch, run `bun <tender>/tender.ts check . --config <tender.json>`, the contract script and `tender verify` again until all three are clean. `TENDER_CONFIG=<tender.json> bun <tender>/intake/contract.ts --recheck <key>` answers `still` or `gone` for one item.

## 2. Suggest intake rules

Read `.tender/config.yaml`'s `intake` and suggest only rules the repo lacks, each with the evidence that qualifies it. The rule, its flags, secrets and network hosts are in `<tender>/docs/intake.md` under the section named.

| Evidence in the repo | Rule | Section |
|---|---|---|
| a `supabase/` dir, or Postgres migrations | `pg-lint.ts`, `pg-slow.ts` | Postgres and Supabase |
| an `@sentry/*` dependency, or `sentry-sdk` in Python deps | `sentry.ts` | Sentry |
| a `posthog-js` or `posthog-node` dependency, or `posthog` in Python deps | `posthog-errors.ts` | PostHog |
| `shortcut:` comments (`git grep -n 'shortcut:'`) | `shortcuts.ts` | Example scripts |
| no `contract` rule yet | `contract.ts` | Contract |

For each, show the rule block from the doc filled in from the repo (project slugs), with `labels` set, `autoLabel: []` and no `judge` key, so tickets start in shadow: nothing gives them the ready label. Add `judge: { minWorth, minFixable }` only when the user wants the host's judge to label them. The user copies the script from `<tender>/intake/` to `.tender/intake/`, keeps it executable, adds any secrets to the host's `.env`, and enables the rule in `tender.json` `intake.enabled`.

## 3. Hand off

Once the user has applied the changes, run `bun <tender>/tender.ts check . --config <tender.json>` once more, then tell the user to commit `.tender/` and push it to the base branch, through a PR if the branch is protected. tender never auto-merges changes to `.tender/**`.
