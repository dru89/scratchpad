#!/usr/bin/env bash
# Updates a Linux install that runs from this checkout (see install-linux.sh,
# which you run once first): pulls, reinstalls the daemon and CLI, rebuilds
# the app, and restarts it in the background.
#
#   update-linux.sh [--no-pull]
#
# The old daemon exits by itself once its binary is replaced; stopping it
# here just makes the switch immediate.

set -euo pipefail

here=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
repo=$(dirname "$here")
electron="$here/node_modules/electron/dist/electron"

pull=1
for arg in "$@"; do
  case $arg in
    --no-pull) pull=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$repo"
[[ $pull == 1 ]] && git pull --ff-only
cargo install --locked --quiet --root ~/.local --path crates/daemon
cargo install --locked --quiet --root ~/.local --path crates/cli
(cd "$here" && npm install --no-fund --no-audit --loglevel=error && npm run build --silent)

# Quit the running app the way the menu would, and wait for it to go.
# Chromium puts switches before the app's path: electron --background <app>.
running() { pgrep -f -- "^$electron( .*)? $here( |\$)" >/dev/null; }
if running; then
  "$here/bin/scratchpad-app" --quit
  for _ in $(seq 50); do running || break; sleep 0.2; done
fi
~/.local/bin/scratchpad daemon stop >/dev/null 2>&1 || true

setsid -f "$here/bin/scratchpad-app" --background >/dev/null 2>&1 </dev/null
echo "Updated to $(node -p "require('$here/package.json').version") ($(git -C "$repo" rev-parse --short HEAD)); scratchpad is running in the background."
