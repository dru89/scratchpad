#!/usr/bin/env bash
# Run every variant's automated benchmarks back to back, then summarize.
# Windows will pop up and scroll on their own; leave the machine alone
# until it finishes (about a minute per variant).
#
#   bench-all.sh [variant ...]

set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
variants=("$@")
mkdir -p "$here/results"
[[ ${#variants[@]} -eq 0 ]] && variants=(tauri-default tauri-nodmabuf tauri-nocompositing tauri-x11 electron-wayland electron-x11)

for v in "${variants[@]}"; do
  echo "== $v"
  timeout 240 "$here/scripts/run.sh" "$v" --autorun >"$here/results/$v.log" 2>&1
  echo "   exit $? (log: results/$v.log)"
  sleep 2
done

node "$here/scripts/summarize.mjs"
