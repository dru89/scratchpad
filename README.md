# scratchpad

Working name for a Drafts-style scratchpad: a place where text starts, gets shaped, and then gets copied somewhere else. The daemon, CLI and MCP server work today; the app doesn't exist yet.

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

See [`docs/design.md`](docs/design.md) for the v1 design, [`docs/decisions.md`](docs/decisions.md) for the reasoning, and [`docs/research.md`](docs/research.md) for the background.

## Next

1. ~~**Design note.**~~ Done: [`docs/design.md`](docs/design.md).
2. ~~**Editor binding spike.**~~ Done: [`spikes/editor-binding`](spikes/editor-binding/). Each window keeps a Loro copy of the draft bound to CodeMirror; agent edits merge live and undo stays local.
3. ~~**Daemon, CLI and MCP.**~~ Done: [`crates/`](crates/). Agents can use drafts before there's a UI.
4. **Electron app on Linux.** Sidebar (Inbox/Archive/Trash), multi-window, a capture window created hidden at startup and opened by a KDE shortcut, float-on-top via KWin, and rich copy. Then use it in place of Drafts on Linux.
5. **Sync.** A Rust server on ds9, E2EE via Loro `%ELO`, and device enrollment. Plus the Mac build of the Electron app.
6. **iOS app.**

## Using it

Build and install the daemon and CLI (Rust 1.89 or newer):

```bash
cargo install --locked --root ~/.local --path crates/daemon && cargo install --locked --root ~/.local --path crates/cli
```

`scratchpad` starts the daemon (`scratchpadd`) the first time it needs it.

```bash
scratchpad new "# Idea" "for later"      # prints the new draft's id
echo "more thoughts" | scratchpad append 01M3F9ZX7F
scratchpad list                          # Inbox, newest first; --archived, --trash, --all
scratchpad search sync "rich copy"       # every word must match; phrases in quotes
scratchpad edit 01M3F9ZX7F                     # $EDITOR; typing done elsewhere meanwhile is kept
scratchpad archive 01M3F9ZX7F                  # also trash, restore
```

Any unique prefix of an id works. Add `--json` to any command for machine-readable output.

To give an agent access, register the MCP server. For Claude Code, in every project:

```bash
claude mcp add --scope user scratchpad -- ~/.local/bin/scratchpad mcp
```

(That assumes `cargo install --root ~/.local`; adjust the path to wherever `scratchpad` lives.)

Data lives in `~/.local/share/scratchpad/` on Linux and `~/Library/Application Support/dev.unremarkable.scratchpad/` on macOS. The daemon logs to `daemon.log` there.

## Developing

```bash
cargo test --workspace         # unit tests plus end-to-end tests of the real binaries
cargo build --release && scripts/load-test.py   # timings with 2,000 drafts and a 100k-word draft
```

`SCRATCHPAD_DATA_DIR` and `SCRATCHPAD_SOCKET` point a daemon and its clients somewhere other than the defaults, which is how the tests stay isolated.

## Layout

- `crates/core/`: the draft model, SQLite store, titles, search, rendering and protocol types. It's a library so the iOS app can embed it.
- `crates/daemon/`: `scratchpadd`.
- `crates/cli/`: `scratchpad`, including `scratchpad mcp`.
- `docs/`: design, decisions and research notes.
- `spikes/`: throwaway experiments that answer one question each.
- `scripts/`: the load test.
