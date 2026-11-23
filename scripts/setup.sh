#!/usr/bin/env bash
# Usage: scripts/setup.sh [--linear] [--sandbox=none] [owner/repo ...]   Idempotent; never overwrites real files. Writes tender.json for the repos given (GitHub source; --linear adds the example Linear one) and creates their labels.
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
linear=0 sandbox=nono repos=()
for a in "$@"; do
  case $a in
    --linear) linear=1 ;;
    --sandbox=none) sandbox=none ;;
    -*) echo "usage: $0 [--linear] [--sandbox=none] [owner/repo ...]"; exit 1 ;;
    *) repos+=("$a") ;;
  esac
done

for c in bun git gh tmux pgrep $([ "$(uname)" = Darwin ] && echo gtimeout flock || echo timeout systemd-run systemctl); do command -v "$c" >/dev/null || { echo "MISSING: $c"; exit 1; }; done
gh auth status >/dev/null 2>&1 || { echo "MISSING: gh login (gh auth login)"; exit 1; }

[ -e .env ] || { cp .env.example .env && echo "write .env (set LINEAR_API_KEY if you use Linear)"; }
if [ ! -e tender.json ]; then
  bun -e '
    const [host, sandbox, linear, ...repos] = process.argv.slice(1);
    const c = await Bun.file("tender.example.json").json();
    Object.assign(c, { host, defaults: { ...c.defaults, sandbox } }, repos.length && { repos });
    if (linear !== "1") c.sources = c.sources.filter((s) => s.tracker !== "linear");
    await Bun.write("tender.json", JSON.stringify(c, null, 2) + "\n");
  ' "$host" "$sandbox" "$linear" "${repos[@]}"
  echo "write tender.json (check repos and sources)"
fi

sandboxes=" $(bun -e 'import { parseConfig } from "./src/config/config"; const c = parseConfig(await Bun.file("tender.json").json(), process.cwd()); console.log([...Object.values(c.repos).map((r) => r.sandbox), c.intake?.host === c.host && "intake"].filter(Boolean).join(" "))' 2>/dev/null || echo nono none) "
case $sandboxes in
  *" nono "* | *" intake "*)
    if ! command -v nono >/dev/null; then
      echo "install nono -> ~/.local/bin"
      curl -fsSL https://nono.sh/install.sh | NONO_INSTALL_DIR="$HOME/.local/bin" sh
    fi
    for f in nono/tender-*.json; do nono profile validate "$f" >/dev/null && echo "ok   $f"; done ;;
esac

for repo in "${repos[@]}"; do
  for l in agent in-progress in-review ready-to-merge needs-human "host:$host"; do
    gh label create "$l" --repo "$repo" --force >/dev/null && echo "label $repo $l"
  done
done

todo=0
# nono sessions use your own login in ~/.claude through nono's proxy; this is tender's own startup check of it.
case $sandboxes in *" nono "*) bun -e 'import { checkLogin, readLogin } from "./src/session/claude-auth"; try { const w = checkLogin(readLogin(process.env.HOME), Date.now()); if (w) console.log(`WARN: ${w}`) } catch (e) { console.log(`TODO: ${e.message}`); process.exit(1) }' || todo=1 ;; esac
case $sandboxes in *" none "*) [ -s ~/.claude-tender/oauth-token ] || { todo=1; echo "TODO: claude setup-token, then save the token to ~/.claude-tender/oauth-token (chmod 600); needed by sandbox: \"none\" repos"; } ;; esac
CODEX_HOME=~/.codex-tender codex login status >/dev/null 2>&1 || { todo=1; echo "TODO: CODEX_HOME=~/.codex-tender codex login"; }
grep -Eq '"tracker": *"linear"' tender.json && echo "Linear sources: create labels agent, needs-human and host:$host in the team, and set LINEAR_API_KEY in .env."
[ "$todo" = 0 ] && echo "Setup done. Next: scripts/run.sh"
exit 0
