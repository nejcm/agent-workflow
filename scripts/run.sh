#!/usr/bin/env bash
# Usage: scripts/run.sh [once|service|intake-service|prs-service]   Preflight, then poll in the foreground; "service" installs the systemd user unit, "intake-service" the intake timer, "prs-service" the weekly PR sweep.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
export PATH="$HOME/.local/bin:$PATH"

[ -e tender.json ] || { echo "tender.json missing: run scripts/setup.sh first"; exit 1; }
sandboxes=" $(bun -e 'import { parseConfig } from "./src/config/config"; const c = parseConfig(await Bun.file("tender.json").json(), process.cwd()); console.log([...Object.values(c.repos).map((r) => r.sandbox), c.intake?.host === c.host && "intake"].filter(Boolean).join(" "))' 2>/dev/null || echo nono) "
case $sandboxes in *" nono "* | *" intake "*) nono=nono ;; *) nono= ;; esac
for c in bun git gh tmux $nono systemd-run systemctl; do command -v "$c" >/dev/null || { echo "MISSING: $c (run scripts/setup.sh)"; exit 1; }; done
out=$(bun tender.ts once --dry-run 2>&1) || { echo "$out"; echo "preflight failed: bun tender.ts once --dry-run"; exit 1; }
if grep -E ' failed[:,]| unavailable' <<<"$out"; then echo "preflight failed: the errors above (full log: bun tender.ts once --dry-run)"; exit 1; fi

# systemd's PATH lacks user tool dirs (~/.bun/bin, mise shims), so units get the ones this shell resolves.
unit() {
  local path
  path=$({ for c in bun claude codex gh nono tmux git; do p=$(command -v "$c") && dirname "$p"; done; printf '%s\n' /usr/local/bin /usr/bin /bin; } | awk '!seen[$0]++' | paste -sd:)
  mkdir -p ~/.config/systemd/user
  sed "s|^WorkingDirectory=.*|WorkingDirectory=$PWD|; s|^ExecStart=.*|ExecStart=$(command -v bun) tender.ts $2 --config tender.json|; s|^Environment=PATH=.*|Environment=PATH=$path|" "systemd/$1.service" > ~/.config/systemd/user/"$1".service
}

case "${1:-run}" in
  run) exec bun tender.ts run ;;
  once) exec bun tender.ts once ;;
  service)
    unit tender run
    systemctl --user daemon-reload && systemctl --user enable --now tender
    echo "service started: systemctl --user status tender; sessions: tmux attach -t tender" ;;
  intake-service)
    unit tender-intake intake
    cp systemd/tender-intake.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now tender-intake.timer
    echo "intake timer started: systemctl --user list-timers tender-intake; logs: journalctl --user -u tender-intake" ;;
  prs-service)
    unit tender-prs prs
    cp systemd/tender-prs.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now tender-prs.timer
    echo "PR sweep timer started: systemctl --user list-timers tender-prs; logs: journalctl --user -u tender-prs" ;;
  *) echo "usage: $0 [run|once|service|intake-service|prs-service]"; exit 1 ;;
esac
