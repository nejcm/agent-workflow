# Upgrading

## To stricter config checks

`tender.json` rejects unknown keys at the top level, in `defaults` and in `repos[]` (since #89), and string settings given as another type (`tmuxSession`, a source `name`, a Linear `team`, `workspaceRoot`, `reposRoot`). Path globs in `criticalPaths`, `testPaths` and `trust` fail to load with surrounding spaces, a leading `!`, `{` or `}`, a backslash, a `.` or `..` segment, or `//`. Before, such a key was silently ignored, and such a glob matched only a path spelled with those characters literally (`docs/{draft}/**` matched a directory named `{draft}`, `!x.md` a file named `!x.md`), so `*.{ts,tsx}` or `./src/**` matched nothing. Fix the key or glob the error names: write `src/**` for `./src/**`, and one glob per extension for `*.{ts,tsx}`. `[` and `]` still match themselves, so `*.[jt]s` matches no file. A `repos[].path` inside a configured repo's `<workspaceRoot>/<owner>/<name>` (directly or through a symlink) now fails to load, as a done ticket's cleanup could delete it; move that clone elsewhere. Escape hatches and critical paths grew, so some PRs that auto-merged before are now held; see [Auto-merge](auto-merge.md).

## To ticket types

A ticket labelled `type:bug` or `type:docs`, or a GitHub issue with that issue type, now gets tender's steps for that type, see [Prompt](config.md#prompt); the bug reproduce-first guidance moved out of the base plan step into the `bug` type. A GitHub issue type counts as the label `type:<name>`, so a repo's `byLabel` entry for `type:<name>` now also matches issues of that type, its `agent` included. Listing reads the `issueType` field, so update `gh` to 2.94.0 or later first.

## To prompt steps

tender's single prompt file is now a fixed header and protocol around six steps a repo can replace, see [Prompt](config.md#prompt). In each repo's `.tender/config.yaml`:

- `planStep: <text>` becomes `plan: <text>` under `prompt:` and `steps:`, in block style (a comma ends plain text inside `{ … }`):

  ```yaml
  prompt:
    steps:
      plan: <text>
  ```

- `prompts.default`, or a `.tender/prompts/default.md` used without a key, no longer replaces the whole prompt: move what differs from tender's into `prompt.steps.<step>` (text or `{ file: <name>.md }`) and `prompt.append`, and delete `default.md`.
- `prompts.byLabel: { <label>: <file> }` becomes `byLabel: { <label>: { prompt: … } }`, block style as above. Each old file was a whole prompt, so cut it down to the steps it changes, like `default.md`, and reference what is left as `{ file: <file> }`.
- `{{planStep}}` is gone; a file that keeps it shows the agent a literal `{{planStep}}`.

A session now records its agent in `<ID>.agent` as JSON when it has a model or effort; an older tender reads that as a Claude session, so finish such sessions before downgrading.

Commit the change to the base branch before upgrading tender: an old key is an error, and a repo with an invalid `.tender/` starts no tickets and resumes no handed-off sessions. Running sessions keep the prompt they were started with.

## To `.tender/config.yaml`

Move `agent`, `testCmd`, `planStep` and `testPaths` (and any `criticalPaths` that belong to the repo rather than the host) from `tender.json` (`defaults` and each repo) into each repo's `.tender/config.yaml`, along with the `autoMerge` you want there (`tender.json`'s `autoMerge` is now its ceiling; its `criticalPaths` stay as a floor), and a custom `prompt` into `.tender/prompts/default.md`. Commit it to the base branch; `tender` does not read it from anywhere else. `baseBranch` now defaults to the remote's default branch. A session records its agent in `<ID>.agent` next to its clone; sessions started before have none and are treated as Claude sessions, so finish or restart running Codex sessions before upgrading.

## From `aw`

`aw` is now `tender`. With nothing running (`systemctl --user disable --now aw && rm ~/.config/systemd/user/aw.service`), rename the config and the agent config dirs, then reinstall the service:

```bash
mv aw.json tender.json
mv ~/.claude-aw ~/.claude-tender && mv ~/.claude-aw.lock ~/.claude-tender.lock && mv ~/.codex-aw ~/.codex-tender
scripts/setup.sh && scripts/run.sh service   # enables tender.service
```

Delete the old `# >>> aw state hooks` block from `~/.codex-tender/config.toml` (`scripts/setup.sh` adds the `tender` one). Old `aw:` comments and `aw-findings` markers on open tickets are still recognised, but tender reads the agent scratch dir at `.tender/run/`, not `.aw/`, so finish or restart sessions started by `aw`. A `"tmuxSession": "aw"` in your config keeps working; the default is now `tender`.

## From the `repos` map

`repos` used to be an object keyed by `"owner/name"`; that form is rejected at startup. Turn each `"owner/name": {}` into `"owner/name"` and each `"owner/name": { … }` into `{ "name": "owner/name", … }`. `sources[].repos` is gone (rejected at startup): a GitHub source polls every repo in `repos`. Worktrees moved from `<workspaceRoot>/<owner>__<name>/<ID>` to `<workspaceRoot>/<owner>/<name>/<ID>`; old ones are not seen any more. Finish or close those tickets first, or remove them by hand (`git -C <clone> worktree remove <old>`, then the `<ID>.*` files). To keep one, first stop its session (`tmux kill-window -t 'tender:<owner>__<name>/<ID>'`; `tender` would not recognise the old window name and would start a second session), then `git -C <clone> worktree move <old> <new>`, move `<ID>.phases.json` and `<ID>.source` alongside (create `<ID>.source` with the source name if there is none), and delete `<ID>.sh` and `<ID>.prompt.md`: they hold the old absolute paths and are regenerated when the ticket starts again. Move the ticket back to ready to resume in the moved worktree.

## From `lanes`

`lanes` is rejected at startup. Move each lane's `repo` into `repos` (with its `repoPath` as `path`, plus `baseBranch`, `agent`, `sandbox`, `testCmd`, `maxConcurrent`, `prompt`) and keep the rest (`name`, `tracker`, labels, Linear states and `team`) as a source; Linear tickets or projects must now name their repo. Worktrees in the old `<workspaceRoot>/<lane>/<ID>` layout are not seen any more: finish or close those tickets first, or remove them by hand (`git -C <clone> worktree remove <workspaceRoot>/<lane>/<ID>`, then the `<ID>.*` files).
