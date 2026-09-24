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

## Stack

- Editor: CodeMirror 6 live preview, with the markdown string as the only source of truth.
- Desktop: **Electron** (decided 2026-09-23 after [`spikes/shell-test`](spikes/shell-test/)). The long-term macOS shell is still open.
- Core: Rust (SQLite, Loro CRDT, crypto, sync). Whether it's a napi-rs module or a separate daemon is still open.
- iOS: SwiftUI shell hosting the same editor in a WKWebView, native text view for quick capture.
- Sync: small Rust server storing opaque encrypted records (Loro `%ELO` framing).

See [`docs/decisions.md`](docs/decisions.md) for the reasoning and [`docs/research.md`](docs/research.md) for the background.

## Next

Build a local-only Linux app on Electron: sidebar, Inbox/Archive/Trash with auto-purge, multi-window, capture window on a KDE shortcut, float-on-top through KWin, rich copy, and a CLI/MCP for agents. Store drafts as Loro documents from the start so sync plugs in later. Settle the core-placement question first.

## Layout

- `docs/` — decisions and research notes.
- `spikes/` — throwaway experiments that answer one question each.
