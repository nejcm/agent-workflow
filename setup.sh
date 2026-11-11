#!/usr/bin/env bash
# Usage: ./setup.sh [owner/repo ...]   Idempotent; never overwrites real files.
set -euo pipefail

link() {
  if [ -L "$2" ]; then echo "ok   $2"; return; fi
  if [ -e "$2" ]; then echo "skip $2 (exists, not a symlink)"; return; fi
  if [ ! -e "$1" ]; then echo "skip $2 ($1 missing)"; return; fi
  ln -s "$1" "$2" && echo "link $2 -> $1"
}

mkdir -p ~/.claude-aw ~/.claude-aw.lock ~/.codex-aw ~/agent-ws
link ~/.claude/CLAUDE.md ~/.claude-aw/CLAUDE.md
link ~/.claude/AGENTS.md ~/.claude-aw/AGENTS.md
link ~/.claude/skills ~/.claude-aw/skills
link ~/.claude/AGENTS.md ~/.codex-aw/AGENTS.md

if [ ! -e ~/.codex-aw/config.toml ]; then
  cat > ~/.codex-aw/config.toml <<TOML
# aw: the sandbox is nono (or the VM); Codex's own sandbox and approvals are off.
sandbox_mode = "danger-full-access"
approval_policy = "never"

[projects."$HOME/agent-ws"]
trust_level = "trusted"
TOML
  echo "write $HOME/.codex-aw/config.toml"
else
  echo "ok   ~/.codex-aw/config.toml"
fi

host=$(hostname -s)
cat <<MSG

Next, by hand:

1. Log in the agent-owned configs (separate from your own ~/.claude and ~/.codex):
     CLAUDE_CONFIG_DIR=~/.claude-aw claude          # then /login
       or: CLAUDE_CONFIG_DIR=~/.claude-aw claude setup-token
     CODEX_HOME=~/.codex-aw codex login

2. Pre-trust ~/agent-ws for Remote Control (accept the trust dialog once):
     cd ~/agent-ws && CLAUDE_CONFIG_DIR=~/.claude-aw claude

3. GitHub labels (per repo):
MSG
for repo in "${@:-<owner/repo>}"; do
  for l in agent in-progress in-review "host:$host"; do
    echo "     gh label create '$l' --repo $repo --force"
  done
done
cat <<MSG

4. Linear: create labels agent and host:$host; export LINEAR_API_KEY.
5. cp aw.example.json aw.json, edit, then: bun aw.ts once --dry-run
MSG
