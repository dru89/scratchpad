#!/usr/bin/env bash
# Regenerates the README's screenshots in docs/images from the design
# screenshot run (test/screenshots.spec.ts), at 2x on a virtual display so
# nothing opens on your screen. Linux only: needs xvfb-run and a debug build
# of the workspace (cargo build --workspace).
set -euo pipefail
app=$(cd "$(dirname "$0")/.." && pwd)
out="$app/../docs/images"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$app"
npm run build
env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 SCRATCHPAD_E2E_SCALE=2 SCRATCHPAD_SCREENSHOTS="$tmp" \
  xvfb-run -a -s '-screen 0 2880x2000x24' npx playwright test screenshots

mkdir -p "$out"
while read -r from to; do
  cp "$tmp/$from.png" "$out/$to.png"
done <<'END'
02-main-window main-light
03-main-window-dark main-dark
14-capture-window-pinned-and-floating capture-light
15-capture-window-dark capture-dark
07-quick-switcher switcher
04-editing-a-table-raw-markdown table-editing
END
echo "Updated $out"
