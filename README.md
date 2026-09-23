# scratchpad

Working name for a Drafts-style scratchpad: a place where text starts, gets shaped, and then gets copied somewhere else. Nothing in this repo is the app yet.

## What it needs to do

- Flat list of drafts with three states: Inbox, Archived, Trash. Trash purges itself after N days. No folders, no file names, no filesystem visible to the user.
- Markdown source with live-preview rendering, including tables.
- Copy as rich text (`text/html` + `text/plain` on the clipboard).
- Multi-window, any window can float on top, and a global hotkey opens a quick-capture window.
- Agents can read and edit drafts (CLI + MCP against the local replica).
- Linux (KDE Plasma on Wayland first), macOS, iOS.
- Fast, end-to-end encrypted sync to a self-hostable server.

## Proposed stack (not settled)

- Editor: CodeMirror 6 live preview, with the markdown string as the only source of truth.
- Core: Rust (SQLite, Loro CRDT, crypto, sync), shared via UniFFI.
- Desktop: Tauri or Electron, decided by [`spikes/shell-test`](spikes/shell-test/).
- iOS: SwiftUI shell hosting the same editor in a WKWebView, native text view for quick capture.
- Sync: small Rust server storing opaque encrypted records (Loro `%ELO` framing).

## Layout

- `spikes/` — throwaway experiments that answer one question each.
