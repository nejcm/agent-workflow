# agent-workflow — plan

Move a GitHub issue or Linear ticket to **Todo + `agent-ready`** → a Claude Code or Codex session starts on this machine (or a VM), sandboxed by nono, in its own git worktree, **visible and steerable from the Claude / ChatGPT apps**. It opens a PR; the ticket moves to **In Review**.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Orchestrator | Own poller, `aw` (single Bun/TS file, no deps) | Sortie runs agents headless (`stream-json`), so sessions never show in the apps. The poller starts *interactive* sessions instead. Stateless: state = tracker + tmux + worktrees. |
| Where | This machine as-is; same script on a VM later | No local VM. VM = same `aw` under systemd. |
| Sandbox | [nono](https://github.com/nolabs-ai/nono) (Landlock + seccomp, unprivileged) | Agent only sees its worktree + its own config dir; network allowlist; GitHub credential injected via proxy, scoped to the repo. Makes skipped permission prompts acceptable on the host. |
| Claude sessions | `claude --remote-control "<ID>"` in tmux | Shows in claude.ai/code + Claude mobile app; you can chat with it, and attach locally with tmux. |
| Codex sessions | interactive `codex` (source `cli`) in tmux; `codex remote-control start` daemon | CLI threads are listed by the app (`thread/list` defaults to `cli`/`vscode`); `exec` threads aren't. |
| Trackers | GitHub Issues (labels) and Linear (workflow states) | One adapter each, ~40 lines. |

## Flow

```
poll 60s ─► tickets: Todo + agent-ready + host:<this-host>
  new ticket ──► set In Progress, comment "picked up on <host>"
             ──► git worktree add ~/agent-ws/<lane>/<ID> -b agent/<ID> origin/main
             ──► tmux new-window -t aw -n <lane>/<ID> <ID>.sh   (launcher: nono run … -- claude --remote-control "<ID>: <title>" --permission-mode bypassPermissions "$(cat <ID>.prompt.md)")
  PR exists for agent/<ID> ──► set In Review, comment PR link (Linear auto-links via branch name)
  ticket Done/Canceled ──► kill window, git worktree remove
You: claude.ai/code / phone / ChatGPT app, or `tmux attach -t aw`, or open the worktree in your IDE
```

Prompt template: ticket title + body + "run `<test cmd>`; commit; `git push`; `gh pr create --fill`; if acceptance criteria are missing, ask in this session and stop."

## Layout

```
aw.ts               # poll loop, tracker adapters, tmux/worktree/nono launch (~400 lines)
aw.test.ts          # fake tracker + fake command runner
aw.json             # host + lanes (see aw.example.json, README)
prompts/default.md
nono/aw-claude.json # extends nono's `default` + groups, NOT nolabs-ai/claude (that grants rw ~/.claude)
nono/aw-codex.json  # same shape for Codex (not nolabs-ai/codex: rw ~/.codex, ~/.agents, ~/.cache)
setup.sh            # agent-owned ~/.claude-aw, ~/.codex-aw; prints login + label commands
systemd/aw.service  # user unit, KillMode=process so tmux survives restarts
```

"Swim lanes" = entries in `aw.json` (one Linear team or GitHub repo each, own agent + concurrency).

## Phases

1. **Sandbox spike** (done when: a Claude and a Codex session in nono can edit only the worktree, push the branch and open a PR, and are visible in claude.ai/code / ChatGPT app)
   - `nono run --allow-cwd --network-profile claude-code -- claude --remote-control test "…"`
   - Check: `~/.ssh`, other repos, `~/.config` unreadable; `gh pr create` works via credential injection; Remote Control works from inside the sandbox (needs claude.ai network + `~/.claude`).
2. **GitHub lane** (done when: label an issue → PR, issue labelled `in-review`)
3. **Linear lane** (done when: same from a Linear team; PR linked in Linear)
4. **VM** (done when: same `aw` + systemd on a Hetzner box over Tailscale; `host:vm` tickets go there)
5. **Later, only if needed**: feed PR review comments back into the session (`tmux send-keys`), Codex `dispatch` by label `agent:codex`.

## Your configs inside nono

| | Works as-is | Needs a profile tweak |
|---|---|---|
| Claude (`nolabs-ai/claude`: rw `~/.claude`, `~/.claude.json`) | CLAUDE.md/AGENTS.md, settings, plugins (ponytail), real-dir skills | Symlinked skills → `~/.agents/skills`, `/usr/share/omarchy/...`: add read grants. Tools from mise (`~/.local/share/mise`), `~/.bun`: add read+exec. |
| Codex (`nolabs-ai/codex`: rw `~/.codex`, `~/.agents`) | config.toml, AGENTS.md, skills | Bundled plugins/MCP in `~/.cache/codex-runtimes`, `/usr/lib/chatgpt` (browser, computer-use) — leave out. |

- **Agent-owned config dir**: rw on `~/.claude` lets a prompt-injected ticket edit your global CLAUDE.md, settings, hooks — persistence outside the sandbox. Use `CLAUDE_CONFIG_DIR=~/.claude-aw` (own login via `claude setup-token`) with *read-only* grants to your CLAUDE.md, AGENTS.md, skills. Codex: `CODEX_HOME=~/.codex-aw`, same idea.
- **nono touches dotfiles**: on first run it moves `~/.claude.json` into `~/.claude/.claude.json` and leaves a symlink (tracked in your home git repo); `nono pull nolabs-ai/codex` writes a fenced block into `~/.codex/config.toml`. The agent-owned dirs above avoid both.
- **Codex + nono on Linux requires `--no-daemon`**, so a sandboxed Codex session can't be live-steered from the ChatGPT app via the daemon; it only appears in history. Claude Remote Control has no such conflict (to verify in phase 1).

## Verify (unconfirmed)
- Claude Desktop app's sidebar may not list terminal-started sessions ([#101326](https://github.com/anthropics/claude-code/issues/101326)); claude.ai/code + mobile do (official docs).
- Codex app listing CLI sessions has reported sync bugs ([#29553](https://github.com/openai/codex/issues/29553)); `codex remote-control` is experimental.
- nono credential injection with `gh`/`git push` — exact config not in docs read so far.
- Remote Control requires workspace trust per worktree dir — pre-trust `~/agent-ws` or each new worktree is prompted.
- Interactive sessions don't exit on finish; "done" is detected by PR existence, not process exit. The launcher `exec`s the agent, so a window disappears only when the agent exits; no window + no PR = one "session ended without a PR" comment.
- Codex `--no-daemon` is passed only with `sandbox: "nono"`; with `"none"` (VM) the daemon stays, so the session can be live-steered.

## Sortie vs own poller

Sortie (retries, cost caps, review-comment loop, dashboard) is the better product if headless is fine. Visibility in the apps is the requirement that tips it: Sortie can wrap the agent in nono (`agent.command`) but not make its sessions interactive. Revisit Sortie if visibility stops mattering.

## Risks
- `bypassPermissions` safety rests entirely on the nono profile — phase 1 must prove the boundaries before any real ticket.
- Subscription limits assume ordinary individual use; cap `maxConcurrent` (start at 2).
- Ticket quality decides outcomes.
