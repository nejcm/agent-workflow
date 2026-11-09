# aw

Polls GitHub Issues or Linear for ready tickets and, per ticket, starts an interactive
Claude Code or Codex session in tmux, in its own git worktree, optionally inside the
[nono](https://github.com/nolabs-ai/nono) sandbox. The agent pushes `agent/<ID>` and opens
a PR; `aw` then moves the ticket to review. No database: state is the tracker, the tmux
windows and the worktrees. Bun + TypeScript, no dependencies.

## Flow (one pass, per lane)

1. Ticket closed / in a `done` state and its worktree exists: kill its window,
   `git worktree remove` (no `--force`; on failure it is logged and kept), delete
   `<ID>.prompt.md`, `<ID>.sh`, `<ID>.ended`.
2. Ready tickets, while windows for the lane < `maxConcurrent`: claim (in progress +
   comment), `git fetch`, `git worktree add <workspaceRoot>/<lane>/<ID> -b agent/<ID>`,
   render the prompt next to the worktree, write a launcher script, `tmux new-window`.
3. In-progress tickets claimed by this host: PR for `agent/<ID>` exists → review + PR link
   comment. No PR and no window → comment "session ended without a PR" once.

Ready means: GitHub open + `readyLabel` + `host:<host>`; Linear `todo` state + `agent-ready`
+ `host:<host>`. Ticket IDs are `gh-<number>` or the Linear identifier (`ENG-42`).
Window names are `<lane>/<ID>`. The launcher `exec`s the agent, so when the agent exits the
window closes; that is the "ended" signal. Use `tmux attach -t aw` to watch or steer.

## Setup

```sh
./setup.sh acme/web            # agent-owned ~/.claude-aw, ~/.codex-aw; prints logins + labels
cp aw.example.json aw.json     # edit host, lanes
bun aw.ts once --dry-run       # logs every side effect instead of doing it
```

Linear needs `LINEAR_API_KEY`. GitHub uses your authenticated `gh`.

## Config

| key | default | |
|---|---|---|
| `host` | required | label `host:<host>` |
| `pollIntervalMs` | 60000 | |
| `workspaceRoot` | `~/agent-ws` | |
| `tmuxSession` | `aw` | |
| `lanes[].name` | required | `[a-z0-9-]` |
| `lanes[].tracker` | required | `github` \| `linear` |
| `lanes[].repo` | required | GitHub `owner/name` PRs go to |
| `lanes[].repoPath` | required | local clone |
| `lanes[].baseBranch` | `main` | |
| `lanes[].agent` | required | `claude` \| `codex` |
| `lanes[].sandbox` | required | `nono` \| `none` |
| `lanes[].maxConcurrent` | 2 | |
| `lanes[].testCmd` | required | |
| `lanes[].prompt` | `prompts/default.md` | relative to the config file |
| github: `readyLabel`, `inProgressLabel`, `inReviewLabel` | `agent-ready`, `in-progress`, `in-review` | done = closed |
| linear: `team`, `todo`, `inProgress`, `inReview`, `done` | -, `Todo`, `In Progress`, `In Review`, `[Done, Canceled, Duplicate]` | `readyLabel` also applies |

## Running

- Foreground: `bun aw.ts run` (`once`, `status`; `--dry-run`, `--config <path>`).
- systemd user unit: `cp systemd/aw.service ~/.config/systemd/user/ && systemctl --user enable --now aw`.
  Adjust `WorkingDirectory` and `PATH` (gh, claude, codex, nono must be on it). Secrets go
  in `~/.config/aw/env`. `KillMode=process` keeps tmux sessions alive across restarts.
- VM: same unit, `"sandbox": "none"` (the VM is the boundary). Codex then runs without
  `--no-daemon`, so it can be steered through the daemon / app.

## Launch commands

- claude: `CLAUDE_CONFIG_DIR=$HOME/.claude-aw [nono run --profile nono/aw-claude.json --allow <wt> --allow <repoPath>/.git --] claude --remote-control "<ID>: <title>" --permission-mode bypassPermissions "$(cat <ID>.prompt.md)"`
- codex: `CODEX_HOME=$HOME/.codex-aw [nono run --profile nono/aw-codex.json --allow … --] codex [--no-daemon] --sandbox danger-full-access --ask-for-approval never -C <wt> "$(cat <ID>.prompt.md)"`

Flags checked against `claude --help` (2.1.319) and `codex --help` (codex-cli 0.167.0),
including `--no-daemon`. Ticket text only reaches the prompt file; the title in the Remote
Control name is reduced to `[\w .,:()#-]` and quoted.

## Phase-1 manual checklist

- [ ] Inside a sandboxed session: `cat ~/.ssh/id_*`, `ls ~/Work/<other-repo>`, `ls ~/.config` fail.
- [ ] Writing `~/.claude/CLAUDE.md` and `~/.claude/settings.json` fails; reading CLAUDE.md, AGENTS.md, skills works.
- [ ] `env | grep -i token` shows only phantom values; `LINEAR_API_KEY` is absent (profiles allow-list env vars).
- [ ] With an SSH `origin` (`git@github.com:…`), push still goes over HTTPS via the `insteadOf` rewrite.
- [ ] Sandboxed Codex reaches `chatgpt.com` (inference) and `auth.openai.com` (token refresh).
- [ ] `git push -u origin agent/<ID>` and `gh pr create` work.
- [ ] Claude session visible and steerable on claude.ai/code / mobile.
- [ ] Codex session in ChatGPT app history.
- [ ] Label an issue → PR → issue gets `in-review`; close it → window and worktree gone.

## Unverified

- nono profiles were written from nono's schema and docs, not run (`nono profile validate nono/aw-claude.json`).
- Git push credential: the `github_git` `basic_auth` route on `https://github.com` and the
  `GIT_CONFIG_*` credential helper reading `$GITHUB_GIT_TOKEN` are not in nono's docs.
  Whether nono expands `$GITHUB_GIT_TOKEN` in `set_vars` (it should not) and swaps the phantom
  in a Basic header is untested.
- `gh` through the `github` route: `endpoint_rules` (`/repos/**`, `POST /graphql`, `GET /user`)
  may be too tight for some `gh` calls. GraphQL cannot be path-scoped to one repo; the real
  scope is the token, so prefer a fine-grained PAT limited to the lane repos over `gh auth token`.
- `claude-code` / `codex` network profiles may not cover Remote Control's endpoints beyond
  `claude.ai`; add `allow_domain` entries if the session does not show up.
- Linear: `issue(id:)` with an identifier (`ENG-42`) and the `IssueFilter` shape used are from
  memory of Linear's API, not tested here.
- Remote Control trust: whether trusting `~/agent-ws` covers worktrees below it.
- Codex `[projects."~/agent-ws"] trust_level` covering subdirectories.

## Risks

- `bypassPermissions` / `--ask-for-approval never` are safe only as far as the nono profile is.
- `--allow <repoPath>/.git` is read-write (commits need it). The agent can edit `.git/hooks`
  and `.git/config` of the main clone, which run later outside the sandbox. Treat the main
  clone as agent-writable, or use a dedicated clone per lane.
- A failed launch after claim leaves the ticket in progress with a "session ended" comment.
