#!/usr/bin/env bash
# Toggle "keep above" on a window via a one-shot KWin script, since Wayland
# gives clients no way to ask for this themselves. KDE only.
#
#   kwin-keep-above.sh <pid> <exact window caption> <true|false>

set -euo pipefail

pid=$1 caption=$2 on=$3
[[ $pid =~ ^[0-9]+$ ]] || { echo "bad pid" >&2; exit 2; }
[[ $on == true || $on == false ]] || { echo "on must be true|false" >&2; exit 2; }

name="scratchpad-keepabove-$$"
js=$(mktemp --suffix=.js)
cleanup() {
  rm -f "$js"
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

caption_json=$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$caption")
cat >"$js" <<EOF
let n = 0;
for (const w of workspace.windowList()) {
  if (w.pid === $pid && w.caption === $caption_json) { w.keepAbove = $on; n++; }
}
print("$name matched=" + n);
EOF

since=$(date '+%Y-%m-%d %H:%M:%S')
id=$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$js" "$name")
qdbus6 org.kde.KWin "/Scripting/Script$id" org.kde.kwin.Script.run
sleep 0.2
matched=$(journalctl --user --since "$since" --no-pager -o cat 2>/dev/null | grep -o "$name matched=[0-9]*" | tail -1 | cut -d= -f2)
echo "matched ${matched:-?} window(s)"
