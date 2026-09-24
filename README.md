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
- Core: Rust daemon (SQLite, Loro CRDT, crypto, sync) serving the app, a CLI and an MCP server over one local socket. In-process on iOS.
- iOS: SwiftUI shell hosting the same editor in a WKWebView, native text view for quick capture.
- Sync: small Rust server storing opaque encrypted records (Loro `%ELO` framing).

See [`docs/decisions.md`](docs/decisions.md) for the reasoning and [`docs/research.md`](docs/research.md) for the background.

## Next

1. **Design note.** Cover:
   - the data model: the draft record, its states, titles taken from the first line, and trash tombstones;
   - the socket protocol: JSON-RPC over a unix socket, with change notifications and a version handshake;
   - how UI commands like "open capture" get from the CLI through the daemon to the app.
2. **Editor binding spike.** The renderer keeps a Loro replica (`loro-crdt` WASM) bound to CodeMirror and exchanges updates with the daemon. Prove that an agent editing an open draft merges live without moving the cursor or breaking undo. This is the riskiest piece left.
3. **Daemon, CLI and MCP.** CRUD, state changes, trash purge and change subscriptions. Agents can use drafts before there's a UI.
4. **Electron app on Linux.** Sidebar (Inbox/Archive/Trash), multi-window, a capture window created hidden at startup and opened by a KDE shortcut, float-on-top via KWin, and rich copy. Then use it in place of Drafts on Linux.
5. **Sync.** A Rust server on ds9, E2EE via Loro `%ELO`, and device enrollment. Plus the Mac build of the Electron app.
6. **iOS app.**

## Layout

- `docs/` — decisions and research notes.
- `spikes/` — throwaway experiments that answer one question each.
