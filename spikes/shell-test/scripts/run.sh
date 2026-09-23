#!/usr/bin/env bash
# Launch one shell variant. Add --autorun to run the benchmarks, save a
# result JSON under results/, and quit.
#
#   run.sh <variant> [--autorun]
#
# Variants:
#   tauri-default        WebKitGTK, native Wayland, default renderer
#   tauri-nodmabuf       WEBKIT_DISABLE_DMABUF_RENDERER=1 (common NVIDIA workaround)
#   tauri-nocompositing  WEBKIT_DISABLE_COMPOSITING_MODE=1 (heavier workaround)
#   tauri-x11            GDK_BACKEND=x11 (XWayland)
#   electron-wayland     Chromium, native Wayland
#   electron-x11         Chromium under XWayland

set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
variant=${1:?variant required}
[[ ${2:-} == --autorun ]] && export SPIKE_AUTORUN=1

export SPIKE_VARIANT=$variant
export SPIKE_LAUNCH_MS=$(date +%s%3N)

tauri_bin="$here/tauri/target/release/scratchpad-spike"
electron_bin="$here/node_modules/.bin/electron"

case $variant in
  tauri-default) exec "$tauri_bin" ;;
  tauri-nodmabuf) WEBKIT_DISABLE_DMABUF_RENDERER=1 exec "$tauri_bin" ;;
  tauri-nocompositing) WEBKIT_DISABLE_COMPOSITING_MODE=1 exec "$tauri_bin" ;;
  tauri-x11) GDK_BACKEND=x11 exec "$tauri_bin" ;;
  electron-wayland) exec "$electron_bin" --ozone-platform=wayland "$here/electron/main.cjs" ;;
  electron-x11) exec "$electron_bin" --ozone-platform=x11 "$here/electron/main.cjs" ;;
  *) echo "unknown variant: $variant" >&2; exit 2 ;;
esac
