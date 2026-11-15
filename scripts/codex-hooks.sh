#!/usr/bin/env bash
# Usage: scripts/codex-hooks.sh <config.toml>   Adds or refreshes tender's Codex state hooks between the tender markers; the rest of the file is left as is.
set -euo pipefail
file=$1
begin='# >>> tender state hooks (managed by scripts/codex-hooks.sh)'
end='# <<< tender state hooks'

# Writes only into the session's own worktree .tender/run (no cwd or other payload data in the file); never fails the run.
hook() {
  local cmd='head -c 1048576 >/dev/null; [ -d .tender/run ] && [ ! -L .tender ] && [ ! -L .tender/run ] && t=$(mktemp .tender/run/codex-state.XXXXXX) && printf "{\"state\":\"STATE\",\"ts\":%s000}" "$(date +%s)" > "$t" && mv -f "$t" .tender/run/codex-state.json; exit 0'
  printf '[[hooks.%s]]\n[[hooks.%s.hooks]]\ntype = "command"\ntimeout = %s\ncommand = '"'%s'"'\n' "$1" "$1" "$3" "${cmd/STATE/$2}"
}

block=$(
  echo "$begin"
  hook SessionStart idle 5
  hook UserPromptSubmit working 5
  hook PostToolUse working 5
  hook PermissionRequest waiting 5
  hook Stop idle 5
  hook SessionEnd ended 2
  echo "$end"
)

touch "$file"
marks=$(awk -v b="$begin" -v e="$end" '$0 == b { printf "b" } $0 == e { printf "e" }' "$file")
if [ -n "$marks" ] && [ "$marks" != be ]; then echo "skip $file (tender hook markers damaged; fix by hand)"; exit 1; fi
cur=$(awk -v b="$begin" -v e="$end" '$0 == b { f = 1 } f { print } $0 == e { f = 0 }' "$file")
if [ "$cur" = "$block" ]; then echo "ok   $file (tender state hooks)"; exit 0; fi
tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v b="$begin" -v e="$end" '$0 == b { f = 1 } !f { print } $0 == e { f = 0 }' "$file" > "$tmp"
printf '\n%s\n' "$block" >> "$tmp"
if ! bun -e 'Bun.TOML.parse(await Bun.file(process.argv[1]).text())' "$tmp" 2>/dev/null; then echo "skip $file (would not be valid TOML with tender's hooks, e.g. an inline hooks table; fix by hand)"; exit 1; fi
# cat, not mv: keeps the file's mode, owner and a symlinked config.toml in place.
cat "$tmp" > "$file"
echo "write $file (tender state hooks)"
