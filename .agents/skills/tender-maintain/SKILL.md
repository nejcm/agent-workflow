---
name: tender-maintain
description: Maintain a repo's tender setup. Proposes repairs for what tender's contract check reports in .tender/config.yaml and suggests intake rules the repo now qualifies for. Use when the user asks to maintain, repair, update or review a repo's tender config, or acts on a "tender contract" ticket.
---

# tender maintain

Work in the root of a repo that already has `.tender/`; for a repo without one, use the `tender-setup` skill. This skill proposes and never applies: it writes no files. Ask the user for the path to their tender clone, the directory that holds `tender.ts`. It is called `<tender>` below.

Show each proposed change as a diff or a YAML block for the user to apply. tender reads `.tender/` only from `origin/<base branch>`, so nothing takes effect until it is committed and pushed there.

## 1. Check the contract

Run `bun <tender>/intake/contract.ts` from the repo root. It prints one JSON line per broken item and nothing when all is well; a non-zero exit is a failed run, not a finding. A `tender contract` ticket names the same `key`.

- `contract:config:check`: `.tender/` fails `bun <tender>/tender.ts check .`, so tender starts no tickets here. Propose a fix for each listed problem; the keys are documented in `<tender>/docs/config.md` under "Repo config". Errors for `planStep`, `prompts` or `prompts/default.md` mean config from before the prompt split: migrate it as `<tender>/docs/upgrading.md` describes under "To prompt steps".
- `contract:criticalPaths:…` or `contract:trust:…`: the glob in the item's `glob` fact matches no file in `git ls-files`. Find where the files went (`git log --stat -1 -- <old path>` shows the commit that moved or removed them), and propose the new glob or removing it. Never widen a glob to make it match.

After the user applies the fixes, run `bun <tender>/tender.ts check .` and the contract script again until both are clean. `bun <tender>/intake/contract.ts --recheck <key>` answers `still` or `gone` for one item.

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

Once the user has applied the changes, run `bun <tender>/tender.ts check .` once more, then tell the user to commit `.tender/` and push it to the base branch, through a PR if the branch is protected. tender never auto-merges changes to `.tender/**`.
