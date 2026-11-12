#!/usr/bin/env bash
# Usage: ./run.sh [once|service]   Preflight, then poll in the foreground; "service" installs the systemd user unit.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
export PATH="$HOME/.local/bin:$PATH"

[ -e aw.json ] || { echo "aw.json missing: run ./setup.sh first"; exit 1; }
for c in bun git gh tmux nono; do command -v "$c" >/dev/null || { echo "MISSING: $c (run ./setup.sh)"; exit 1; }; done
bun aw.ts once --dry-run >/dev/null

case "${1:-run}" in
  run) exec bun aw.ts run ;;
  once) exec bun aw.ts once ;;
  service)
    mkdir -p ~/.config/systemd/user
    sed "s|^WorkingDirectory=.*|WorkingDirectory=$PWD|; s|^ExecStart=.*|ExecStart=$(command -v bun) aw.ts run --config aw.json|" systemd/aw.service > ~/.config/systemd/user/aw.service
    systemctl --user daemon-reload && systemctl --user enable --now aw
    echo "service started: systemctl --user status aw; sessions: tmux attach -t aw" ;;
  *) echo "usage: $0 [run|once|service]"; exit 1 ;;
esac
