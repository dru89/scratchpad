# scratchpad

Working name for a Drafts-style scratchpad: a place where text starts, gets shaped, and then gets copied somewhere else. The daemon, CLI, MCP server and Linux desktop app work today; sync and the other platforms don't exist yet.

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
4. ~~**Electron app on Linux.**~~ Built: [`app/`](app/). Next is using it in place of Drafts for a while and fixing what that turns up.
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

### The desktop app

```bash
cd app && npm install && npm run build
scripts/install-linux.sh     # launcher, desktop entry, autostart, and the capture shortcut
```

The install script links `~/.local/bin/scratchpad-app`, adds scratchpad to the application launcher, starts it in the background at login (`--no-autostart` to skip), and registers a "scratchpad capture" command with Meta+Shift+2 as its default. Confirm that binding once in System Settings > Keyboard > Shortcuts. `--uninstall` removes it all. Without installing, `npm start` in `app/` runs it directly.

The main window has the sidebar and an editor; the capture window floats and hides with Esc; Ctrl+Enter files a capture and clears it; Ctrl+K finds any draft; Ctrl+Shift+C copies as rich text. The full list is in [`docs/design.md`](docs/design.md#capture-window-actions).

## Developing

```bash
cargo test --workspace         # unit tests plus end-to-end tests of the real binaries
cargo build --release && scripts/load-test.py   # timings with 2,000 drafts and a 100k-word draft
cd app && npm test             # renderer unit tests
cd app && npm run test:e2e     # the real app against a throwaway daemon (needs a display; build the workspace first)
```

`SCRATCHPAD_DATA_DIR` and `SCRATCHPAD_SOCKET` point a daemon and its clients somewhere other than the defaults, which is how the tests stay isolated.

## Layout

- `crates/core/`: the draft model, SQLite store, titles, search, rendering and protocol types. It's a library so the iOS app can embed it.
- `crates/daemon/`: `scratchpadd`.
- `crates/cli/`: `scratchpad`, including `scratchpad mcp`.
- `app/`: the Electron desktop app. `electron/` is the main process, `src/` the windows.
- `docs/`: design, decisions and research notes.
- `spikes/`: throwaway experiments that answer one question each.
- `scripts/`: the load test.
