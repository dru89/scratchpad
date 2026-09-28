#!/usr/bin/env bash
# Sets up the scratchpad app from this checkout on a Linux desktop (KDE
# Plasma first):
#
#   ~/.local/bin/scratchpad-app      a link to this checkout's launcher
#   applications/…scratchpad.desktop  so it shows up in the launcher and
#                                     opens scratchpad:// links
#   icons/hicolor/…/apps/…scratchpad.png  the app icon, at each size
#   autostart/…scratchpad.desktop     starts it in the background at login
#   applications/net.local.scratchpad-main.desktop
#                                     a command that shows or hides the main
#                                     window, with Meta+Shift+1 as its
#                                     default shortcut
#   applications/net.local.scratchpad-capture.desktop
#                                     the same for the capture window, with
#                                     Meta+Shift+2
#
#   install-linux.sh [--no-autostart] [--uninstall]
#
# Re-run it after moving the checkout. Build the app first: npm run build.
# To update later, run update-linux.sh.

set -euo pipefail

here=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
bin="$HOME/.local/bin"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
autostart_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
app_entry="$apps/dev.unremarkable.scratchpad.desktop"
autostart_entry="$autostart_dir/dev.unremarkable.scratchpad.desktop"
main_entry="$apps/net.local.scratchpad-main.desktop"
capture_entry="$apps/net.local.scratchpad-capture.desktop"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
icon_name=dev.unremarkable.scratchpad

autostart=1
for arg in "$@"; do
  case $arg in
    --no-autostart) autostart=0 ;;
    --uninstall)
      rm -f "$bin/scratchpad-app" "$app_entry" "$autostart_entry" "$main_entry" "$capture_entry"
      rm -f "$icons"/*/apps/$icon_name.png
      # The scratchpad:// association in mimeapps.list points at the removed
      # entry now, which is harmless; xdg-mime has no way to unset it.
      command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
      echo "Removed the scratchpad app's launcher, desktop entries, and autostart."
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

[[ -f "$here/dist-electron/main.js" && -f "$here/dist-renderer/index.html" ]] || {
  echo "Build the app first: (cd $here && npm install && npm run build)" >&2
  exit 1
}
cli=$(command -v scratchpad || echo "$bin/scratchpad")
[[ -x "$cli" ]] || {
  echo "Install the CLI first: cargo install --locked --root ~/.local --path crates/cli (and crates/daemon)" >&2
  exit 1
}

mkdir -p "$bin" "$apps"
ln -sf "$here/bin/scratchpad-app" "$bin/scratchpad-app"
for png in "$here"/build/icons/*x*.png; do
  size=$(basename "$png" .png)
  mkdir -p "$icons/$size/apps"
  cp "$png" "$icons/$size/apps/$icon_name.png"
done

cat >"$app_entry" <<EOF
[Desktop Entry]
Type=Application
Name=scratchpad
Comment=Where text starts
Exec=$bin/scratchpad-app %u
Icon=$icon_name
Terminal=false
Categories=Utility;TextEditor;
MimeType=x-scheme-handler/scratchpad;
StartupWMClass=scratchpad
EOF
# scratchpad:// links open drafts in the app.
command -v xdg-mime >/dev/null && xdg-mime default dev.unremarkable.scratchpad.desktop x-scheme-handler/scratchpad || true

if [[ $autostart == 1 ]]; then
  mkdir -p "$autostart_dir"
  sed "s|^Exec=.*|Exec=$bin/scratchpad-app --background|" "$app_entry" >"$autostart_entry"
  echo "X-KDE-autostart-phase=2" >>"$autostart_entry"
else
  rm -f "$autostart_entry"
fi

# The hotkeys: each shows its window, or hides it if it's the one in use.
cat >"$main_entry" <<EOF
[Desktop Entry]
Type=Application
Name=scratchpad main window
Exec=$cli open --toggle
NoDisplay=true
StartupNotify=false
X-KDE-GlobalAccel-CommandShortcut=true
X-KDE-Shortcuts=Meta+Shift+1
EOF

cat >"$capture_entry" <<EOF
[Desktop Entry]
Type=Application
Name=scratchpad capture
Exec=$cli capture --toggle
NoDisplay=true
StartupNotify=false
X-KDE-GlobalAccel-CommandShortcut=true
X-KDE-Shortcuts=Meta+Shift+2
EOF

command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true

cat <<EOF
Installed:
  $bin/scratchpad-app
  $app_entry
  $( [[ $autostart == 1 ]] && echo "$autostart_entry (starts in the background at login)" || echo "(no autostart)")
  $main_entry
  $capture_entry

One manual step: open System Settings > Keyboard > Shortcuts, find
"scratchpad main window" and "scratchpad capture" under Custom Commands (or
search for them), and make sure they're bound to Meta+Shift+1 and
Meta+Shift+2. KDE only applies a default shortcut the first time it sees a
command, so this is the reliable way to set them.
EOF
