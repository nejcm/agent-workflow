#!/usr/bin/env bash
# Usage: scripts/run.sh [once|service|intake-service|prs-service]   Preflight, then poll in the foreground; "service" installs the poller as a user service (systemd or launchd), "intake-service" the intake timer, "prs-service" the weekly PR sweep.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
export PATH="$HOME/.local/bin:$PATH"

[ -e tender.json ] || { echo "tender.json missing: run scripts/setup.sh first"; exit 1; }
sandboxes=" $(bun -e 'import { parseConfig } from "./src/config/config"; const c = parseConfig(await Bun.file("tender.json").json(), process.cwd()); console.log([...Object.values(c.repos).map((r) => r.sandbox), c.intake?.host === c.host && "intake"].filter(Boolean).join(" "))' 2>/dev/null || echo nono) "
case $sandboxes in *" nono "* | *" intake "*) nono=nono ;; *) nono= ;; esac
mac=; [ "$(uname)" = Darwin ] && mac=1
for c in bun git gh tmux $nono $([ -n "$mac" ] && echo gtimeout flock || echo systemd-run systemctl); do command -v "$c" >/dev/null || { echo "MISSING: $c (run scripts/setup.sh)"; exit 1; }; done
out=$(bun tender.ts once --dry-run 2>&1) || { echo "$out"; echo "preflight failed: bun tender.ts once --dry-run"; exit 1; }
if grep -E ' failed[:,]| unavailable' <<<"$out"; then echo "preflight failed: the errors above (full log: bun tender.ts once --dry-run)"; exit 1; fi

case "${1:-run}" in
  run) exec bun tender.ts run ;;
  once) exec bun tender.ts once ;;
  service) exec bun scripts/service.ts run ;;
  intake-service) exec bun scripts/service.ts intake ;;
  prs-service) exec bun scripts/service.ts prs ;;
  *) echo "usage: $0 [run|once|service|intake-service|prs-service]"; exit 1 ;;
esac
