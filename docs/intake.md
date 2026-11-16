# Intake

Intake turns signals (errors, lint debt, slow queries) into tracker tickets. An intake rule is a script in the repo that prints JSON lines; `tender intake` runs it in a sandbox, dedupes, sanitizes and files what it prints. It never starts a session itself: a filed ticket is worked like any other once it has the `agent` label.

## Turning a rule on

A rule lives in the repo's `.tender/config.yaml` (read from the base branch, like the rest of `.tender/`):

```yaml
intake:
  - name: shortcuts                    # [a-z0-9-], unique in the repo
    run: .tender/intake/shortcuts.ts   # executable path inside the repo
    every: 1d                          # 15m, 1h, 1d…; rounded to the 15-min timer
    maxPerRun: 3                       # new tickets per run, in the script's order
    secrets: []                        # env var names; values come from the host
    network: []                        # host names the script may reach; empty = no network
    autoLabel: []                      # empty = shadow: tickets get no labels
    recheck: true                      # run --recheck after the ticket is Done
    recheckAfter: 24h
```

It runs only when the host enables it in `tender.json`, and only on the host named there, so two hosts never both file:

```json
"intake": { "enabled": ["owner/repo:shortcuts"], "host": "laptop" }
```

Run it by hand with `bun tender.ts intake [owner/repo:rule | rule] [--dry-run]`; naming a rule runs it now, whatever its `every`. On the intake host, `scripts/run.sh intake-service` installs `systemd/tender-intake.service` and `.timer`, which run `tender intake` every 15 minutes. `--dry-run` still clones and runs the scripts and searches the tracker, in a throwaway temp dir with a copy of the state file, and does not open `tender.db` at all, so it files, comments and writes nothing and never touches a live run's clone. Without the history it may over-report: keys already filed show as filed again unless the tracker's marker search finds them, every rule runs whatever its `every`, and no recheck is previewed.

## Example scripts

Example scripts live in tender's [`intake/`](../intake) dir; copy one into the repo's `.tender/intake/`, keep it executable, and add a rule.

- `shortcuts.ts`: one ticket per `shortcut:` comment (`// shortcut: <the limit>, <when to upgrade>`), keyed by file and comment text. Needs only the clone: no network, no secrets. `--recheck` reports `still` while the same comment is in that file.

## Script protocol

- **Collect:** `run` with no arguments prints at most 100 JSON lines `{ "key", "title", "body", "facts"? }` and exits 0. `key` is `[A-Za-z0-9.:/-]`, at most 128 chars, unique in the output. `facts` is a flat map of at most 20 numbers and strings, used by `autoLabel`. Order by importance: `maxPerRun` takes the first new keys.
- **Recheck:** `run --recheck <key>` prints one line `{ "state": "gone" | "still", "detail"? }`.
- **Limits:** 5 minutes and 1 MiB of output. A timeout, a non-zero exit, too much output or any malformed line fails that run, which is logged and files nothing.
- **Environment:** `TENDER_STATE` (a file the script may rewrite, kept between runs: `<workspaceRoot>/.intake/<owner>/<name>/<rule>.state`), `TENDER_RULE`, `TMPDIR`, `PATH`, `HOME`, `LANG` and the declared `secrets`. Nothing else.

## Sandbox

Each run gets a fresh `git clone --shared` of `origin/<base>` in `<workspaceRoot>/.intake/<owner>/<name>/<rule>/`, deleted afterwards. The script always runs under `nono/tender-intake.json`, whatever the repo's `sandbox`, and fails if nono cannot run: it can write only that clone, its temp dir and its state file, read the base clone's objects and system paths, reach only the `network` hosts, and sees only the secrets it declares, read from the host environment (`.env`, loaded by Bun from the working directory). Secret names starting with `GH_`, `GITHUB_`, `LINEAR_` and other tender or agent names are rejected, so no `gh` token or tracker key ever reaches a script. The script's output is untrusted data.

## Filing

- **Where:** the repo's Linear project when `.tender/config.yaml` sets `tracker.linear` (the one Linear source, or the one for its `team`), else the repo's GitHub issues through the one GitHub source.
- **Sanitized** as [findings](lifecycle.md#findings): a one-line title of at most 120 chars, control characters stripped, `@` mentions and Linear links neutralized, and `tender-intake` in script text rewritten to `tender_intake`, so a script cannot plant another key's marker. The body opens with "Untrusted data from tender intake rule <rule>", ends with the marker line `tender-intake: <owner>/<name>:<rule>:<key>`, and is at most 4000 chars in all.
- **Dedupe, three layers:** the marker in the body, matched only as a whole line (key `a` never matches `abc`); the `intake_seen` table in `tender.db`; and, before every create, a tracker search for the marker (any state), so a lost database adopts the existing ticket instead of filing a second. A key is filed at most once, ever.
- **Labels:** with `autoLabel` rules, a finding whose facts satisfy any rule gets the ready label (plus `host:<host>` unless `defaultHost`). A rule is a map: `min<Fact>: n` means `facts.<fact> >= n`, any other key is equality; `{ minEvents: 100, level: error }`. Without a match: no labels (shadow).
- **Seen again while open:** `last_seen_at` is updated, and at most once a day a comment lists the new facts if they changed noticeably (a fact added, dropped, a string changed or a number moved by half). Never refiled.
- **Recheck:** once tender sees the ticket Done, `--recheck <key>` runs on the first intake run `recheckAfter` later. `still` posts one comment and reopens it (GitHub) or moves it to Todo (Linear), removing the ready label first; if that removal fails the ticket stays closed. A ticket is rechecked and reopened at most once, except in one case: a reopen that takes effect but reports failure (or tender crashing before recording it), followed by a human closing the ticket before the next run, is reopened again. the comment ends with a `tender-intake-recheck: <rule>:<key>` line and is posted before the reopen, which only follows once it lands. Tender looks for that line before any recheck, so a lost `tender.db` cannot cause a second reopen. A failed comment or reopen is retried next run, unless recheck was turned off or the ticket canceled meanwhile; if `tender.db` is lost between the comment and a failed reopen, the reopen is dropped rather than risk a second one. A marker search that returns over 100 near misses for a key fails the run instead of filing a possible duplicate. `recheckAfter` counts from the merge of `agent/<ID>`, or, for a ticket tender did not merge, from when it first saw it Done. Turning `recheck` off, or a human reopening or canceling the ticket, drops a pending recheck.
- **History:** each filing records an `intake-filed` event in `tender.db`.
