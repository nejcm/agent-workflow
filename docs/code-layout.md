# Code layout

- `tender.ts`: CLI entry (`run`, `once`, `status`, `watch`, `tail`, `open`, `resume`, `intake`, `prs`, `stats`, `check`).

## `src/`

The poll, intake and the helpers every folder shares.

- `src/types.ts`: shared types (`Config`, `Repo`, `Source`, `Ticket`, `Tracker`, `Io`).
- `src/github.ts`: canonical-repo and PR lookup.
- `src/intake.ts`: `intake`: the script protocol, the sandboxed run in a fresh clone, dedupe, filing, open-ticket updates and recheck.
- `src/judge.ts`: the intake judge: ticket selection, the prompt, the sandboxed headless Claude or Codex call, verdict validation, the comment and the labelling decision.
- `src/guardrail.ts`: guardrail proposals: merged agent PRs with feedback from events, the operator's comments from GitHub, the judge call with its own schema, the kind and prose-file guards and the filing.
- `src/prs.ts`: `prs`: open-PR listing, classes, the orphan check and close, the report and digest issue.
- `src/stats.ts`: `stats`: merged and reverted agent PRs per trust path from GitHub, shadow, judge and recheck agreement from events, the recommendation thresholds and the table.
- `src/db.ts`: `tender.db` (bun:sqlite, WAL): ordered SQL migrations and the best-effort event recorder.
- `src/pass.ts`: one poll: cleanup, start ready tickets by priority, reconcile.
- `src/util.ts`: logged/dry-run-aware command and file helpers, the pinned `.tender/run` reader, control-char stripping.

## `src/config/`

Host and repo configuration.

- `src/config/config.ts`: `tender.json` parsing and the repo allowlist.
- `src/config/repo-config.ts`: a repo's `.tender/` read from its base branch, validated, cached per commit and combined with the host settings.

## `src/trackers/`

Ticket trackers.

- `src/trackers/`: tracker adapters (`github.ts`, `linear.ts`) and the `TRACKERS` registry.

## `src/session/`

Agent sessions: launch, live state, questions and feedback.

- `src/session/question.ts`: agent questions: `.tender/run/question.md` posted to the ticket, the operator's answer picked and pasted back into the session.
- `src/session/feedback.ts`: PR reviews, comments, failed checks and conflicts fed back into an idle In Review session.
- `src/session/agents.ts`: the Claude and Codex adapters: launch env and command (with quoted model and effort flags), the session's recorded agent config, valid model names and efforts, config dirs and transcript files, live state (Claude's session records, read as untrusted files; the Codex hook state file).
- `src/session/claude-auth.ts`: the host Claude login: finding the host `claude` and `bun`, reading and checking the login, the refresher that keeps it fresh.
- `src/session/launcher.ts`: base clone, session clone, prompt and launcher script, tmux window, stop and resume.
- `src/session/handoff.ts`: `open`: ticket lookup, transcript copy into your own store, the command per tool.
- `src/session/state.ts`: live state types and precedence.

## `src/review/`

What a session leaves in `.tender/run/` and the merge decision.

- `src/review/phases.ts`: `.tender/run/phases.json` validation and sub-ticket sync.
- `src/review/findings.ts`: `.tender/run/findings.json` validation, sanitizing and filing.
- `src/review/hatch.ts`: escape-hatch patterns, the added-line diff parser and the time-limited worker that runs them.
- `src/review/merge.ts`: `.tender/run/merge.json`, critical paths, trust per path, the merge decision, auto-merge and the Ready to merge check.

## `src/ui/`

`status`, `watch` and `tail`.

- `src/ui/status.ts`: per-worktree status rows, the live-state snapshot and the table.
- `src/ui/dash.ts`: the `watch` dashboard (OpenTUI): keys, selection, attach/open and the renderer wiring.
- `src/ui/dash-view.ts`: the dashboard's pure view: palette, layout, cards, progress bars, detail and transcript rows, every screen line as styled spans.
- `src/ui/tail.ts`: transcript lookup by recorded cwd, line condensing, `tail`.

## Other

- `intake/`: example intake scripts that repos copy into `.tender/intake/`.
- `prompts/`: the ticket prompt: the fixed `header.md` and `protocol.md`, and the default `steps/*.md` a repo's `prompt.steps` can replace.
- `nono/`: sandbox profiles for Claude and Codex sessions, intake scripts, the intake judge and checks.
- `systemd/`: user units for `tender run`, the intake timer and the weekly PR sweep timer, installed by `scripts/run.sh`.
- `.agents/skills/tender-setup/SKILL.md`: the setup skill for a repo's `.tender/`; `.agents/skills/tender-maintain/SKILL.md` proposes repairs and intake rules. `.claude/skills/` symlinks to them for Claude Code.
- `scripts/setup.sh`: idempotent host setup and tracker labels; `scripts/run.sh`: preflight, then poll, or install the systemd units.
- `scripts/codex-hooks.sh`: installs or refreshes tender's Codex state hooks in a `config.toml`.
- `tests/`: one file per module (launcher tests are in `pass.test.ts`, the Ready to merge pass in `ready.test.ts`, `intake/sentry.ts` in `sentry.test.ts`, `intake/posthog-errors.ts` in `posthog-errors.test.ts`, the `intake/pg*.ts` scripts in `pg.test.ts`, `intake/contract.ts` in `contract.test.ts`); shared fakes in `tests/helpers.ts`.
