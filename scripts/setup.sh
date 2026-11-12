#!/usr/bin/env bash
# Usage: scripts/setup.sh [owner/repo ...]   Idempotent; never overwrites real files. Creates labels for the repos given.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

link() {
  if [ -L "$2" ]; then echo "ok   $2"; return; fi
  if [ -e "$2" ]; then echo "skip $2 (exists, not a symlink)"; return; fi
  if [ ! -e "$1" ]; then echo "skip $2 ($1 missing)"; return; fi
  ln -s "$1" "$2" && echo "link $2 -> $1"
}

mkdir -p ~/.claude-aw ~/.claude-aw.lock ~/.codex-aw ~/agent-ws ~/agent-repos
link ~/.claude/CLAUDE.md ~/.claude-aw/CLAUDE.md
link ~/.claude/AGENTS.md ~/.claude-aw/AGENTS.md
link ~/.claude/skills ~/.claude-aw/skills
link ~/.claude/AGENTS.md ~/.codex-aw/AGENTS.md
link ~/.claude/skills ~/.codex-aw/skills

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
scripts/codex-hooks.sh ~/.codex-aw/config.toml

host=$(hostname -s)
export PATH="$HOME/.local/bin:$PATH"

if ! command -v nono >/dev/null; then
  echo "install nono -> ~/.local/bin"
  curl -fsSL https://nono.sh/install.sh | NONO_INSTALL_DIR="$HOME/.local/bin" sh
fi

for c in bun git gh tmux; do command -v "$c" >/dev/null || { echo "MISSING: $c"; exit 1; }; done
gh auth status >/dev/null 2>&1 || { echo "MISSING: gh login (gh auth login)"; exit 1; }

for f in nono/aw-claude.json nono/aw-codex.json; do nono profile validate "$f" >/dev/null && echo "ok   $f"; done

[ -e .env ] || { cp .env.example .env && echo "write .env (set LINEAR_API_KEY if you use Linear)"; }
[ -e aw.json ] || { cp aw.example.json aw.json && sed -i "s/\"host\": \"laptop\"/\"host\": \"$host\"/" aw.json && echo "write aw.json (edit repos and sources)"; }

for repo in "$@"; do
  for l in agent in-progress in-review "host:$host"; do
    gh label create "$l" --repo "$repo" --force >/dev/null && echo "label $repo $l"
  done
done

todo=0
CLAUDE_CONFIG_DIR=~/.claude-aw claude auth status 2>/dev/null | grep -q '"loggedIn": true' || { todo=1; echo "TODO: CLAUDE_CONFIG_DIR=~/.claude-aw claude   # then /login"; }
CODEX_HOME=~/.codex-aw codex login status >/dev/null 2>&1 || { todo=1; echo "TODO: CODEX_HOME=~/.codex-aw codex login"; }
echo "Linear sources: create labels agent and host:$host in the team."
[ "$todo" = 0 ] && echo "Setup done. Next: scripts/run.sh"
exit 0
