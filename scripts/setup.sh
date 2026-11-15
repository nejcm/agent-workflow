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

mkdir -p ~/.claude-tender ~/.claude-tender.lock ~/.codex-tender ~/agent-ws ~/agent-repos
link ~/.claude/CLAUDE.md ~/.claude-tender/CLAUDE.md
link ~/.claude/AGENTS.md ~/.claude-tender/AGENTS.md
link ~/.claude/skills ~/.claude-tender/skills
link ~/.claude/AGENTS.md ~/.codex-tender/AGENTS.md
link ~/.claude/skills ~/.codex-tender/skills

if [ ! -e ~/.codex-tender/config.toml ]; then
  cat > ~/.codex-tender/config.toml <<TOML
# tender: the sandbox is nono (or the VM); Codex's own sandbox and approvals are off.
sandbox_mode = "danger-full-access"
approval_policy = "never"

[projects."$HOME/agent-ws"]
trust_level = "trusted"
TOML
  echo "write $HOME/.codex-tender/config.toml"
else
  echo "ok   ~/.codex-tender/config.toml"
fi
scripts/codex-hooks.sh ~/.codex-tender/config.toml

host=$(hostname -s)
export PATH="$HOME/.local/bin:$PATH"

if ! command -v nono >/dev/null; then
  echo "install nono -> ~/.local/bin"
  curl -fsSL https://nono.sh/install.sh | NONO_INSTALL_DIR="$HOME/.local/bin" sh
fi

for c in bun git gh tmux timeout systemd-run systemctl pgrep; do command -v "$c" >/dev/null || { echo "MISSING: $c"; exit 1; }; done
gh auth status >/dev/null 2>&1 || { echo "MISSING: gh login (gh auth login)"; exit 1; }

for f in nono/tender-claude.json nono/tender-codex.json nono/tender-check.json; do nono profile validate "$f" >/dev/null && echo "ok   $f"; done

[ -e .env ] || { cp .env.example .env && echo "write .env (set LINEAR_API_KEY if you use Linear)"; }
[ -e tender.json ] || { cp tender.example.json tender.json && sed -i "s/\"host\": \"laptop\"/\"host\": \"$host\"/" tender.json && echo "write tender.json (edit repos and sources)"; }

for repo in "$@"; do
  for l in agent in-progress in-review ready-to-merge needs-human "host:$host"; do
    gh label create "$l" --repo "$repo" --force >/dev/null && echo "label $repo $l"
  done
done

todo=0
sandboxes=" $(bun -e 'const c = await Bun.file("tender.json").json(); console.log([c.defaults?.sandbox, ...(c.repos ?? []).map((r) => r?.sandbox)].join(" "))' 2>/dev/null || echo nono none) "
# nono sessions use your own login in ~/.claude through nono's proxy; this is tender's own startup check of it.
case $sandboxes in *" nono "*) bun -e 'import { checkLogin, readLogin } from "./src/claude-auth"; try { const w = checkLogin(readLogin(process.env.HOME), Date.now()); if (w) console.log(`WARN: ${w}`) } catch (e) { console.log(`TODO: ${e.message}`); process.exit(1) }' || todo=1 ;; esac
case $sandboxes in *" none "*) [ -s ~/.claude-tender/oauth-token ] || { todo=1; echo "TODO: claude setup-token, then save the token to ~/.claude-tender/oauth-token (chmod 600); needed by sandbox: \"none\" repos"; } ;; esac
CODEX_HOME=~/.codex-tender codex login status >/dev/null 2>&1 || { todo=1; echo "TODO: CODEX_HOME=~/.codex-tender codex login"; }
echo "Linear sources: create labels agent, needs-human and host:$host in the team."
[ "$todo" = 0 ] && echo "Setup done. Next: scripts/run.sh"
exit 0
