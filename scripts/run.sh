#!/usr/bin/env bash
# Usage: scripts/run.sh [once|service|intake-service]   Preflight, then poll in the foreground; "service" installs the systemd user unit, "intake-service" the intake timer.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
export PATH="$HOME/.local/bin:$PATH"

[ -e tender.json ] || { echo "tender.json missing: run scripts/setup.sh first"; exit 1; }
for c in bun git gh tmux nono systemd-run systemctl; do command -v "$c" >/dev/null || { echo "MISSING: $c (run scripts/setup.sh)"; exit 1; }; done
bun tender.ts once --dry-run >/dev/null

case "${1:-run}" in
  run) exec bun tender.ts run ;;
  once) exec bun tender.ts once ;;
  service)
    mkdir -p ~/.config/systemd/user
    sed "s|^WorkingDirectory=.*|WorkingDirectory=$PWD|; s|^ExecStart=.*|ExecStart=$(command -v bun) tender.ts run --config tender.json|" systemd/tender.service > ~/.config/systemd/user/tender.service
    systemctl --user daemon-reload && systemctl --user enable --now tender
    echo "service started: systemctl --user status tender; sessions: tmux attach -t tender" ;;
  intake-service)
    mkdir -p ~/.config/systemd/user
    sed "s|^WorkingDirectory=.*|WorkingDirectory=$PWD|; s|^ExecStart=.*|ExecStart=$(command -v bun) tender.ts intake --config tender.json|" systemd/tender-intake.service > ~/.config/systemd/user/tender-intake.service
    cp systemd/tender-intake.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now tender-intake.timer
    echo "intake timer started: systemctl --user list-timers tender-intake; logs: journalctl --user -u tender-intake" ;;
  *) echo "usage: $0 [run|once|service|intake-service]"; exit 1 ;;
esac
