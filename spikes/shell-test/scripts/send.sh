#!/usr/bin/env bash
# Send a command to whichever shell is running. Bind a KDE custom shortcut to
# `send.sh capture` to test the hotkey path. Forwards the activation token
# KWin hands to shortcut commands, so we can see whether it arrives.
#
#   send.sh [capture|capture-cold|quit]

sock="${XDG_RUNTIME_DIR:-/tmp}/scratchpad-spike.sock"
printf '%s %s\n' "${1:-capture}" "${XDG_ACTIVATION_TOKEN:-}" | socat - "UNIX-CONNECT:$sock"
