# Research notes (September 2026)

Condensed from the initial scoping. Sources are linked where a claim is load-bearing.

## Requirements

- A flat list of drafts with three states: Inbox, Archived, Trash. Trash purges itself after N days. No folders, no file names, no filesystem visible to the user.
- Markdown source with live-preview rendering, including tables.
- Copy as rich text (`text/html` and `text/plain` on the clipboard).
- Multiple windows, any window can float on top, and a global hotkey opens a quick-capture window.
- Agents can read and edit drafts, through a CLI and an MCP server against the local replica.
- Linux (KDE Plasma on Wayland first), macOS and iOS.
- Fast, end-to-end encrypted sync to a self-hostable server.

## Why build this at all

No existing app covers those requirements. The closest:

- **Obsidian + Self-hosted LiveSync** covers the most on paper (plain files, live-preview tables, pop-out windows, E2EE sync to your own CouchDB). But it's a files-and-folders app, so every note is a filing decision, which is the "too permanent" feeling. Large tables lag in Live Preview, and iOS only syncs while the app is open.
- **Notesnook** feels the most like Drafts (flat list, first-line titles, archive, trash that auto-clears, fast E2EE sync). But it stores rich text rather than markdown, has no separate windows, hotkey or agent API, and its self-hosted server is an Oct 2025 beta marked not production-ready.
- **Joplin 3.7** added in-editor rendering, a table editor and a built-in MCP server, but sync polls on a 5-minute minimum.
- **Drafts** has no Linux or web editor. Its newer TextKit 2 editor is the likely source of the large-document glitches.
- **Ruled out:** Heynote (no sync or mobile), Bear (Linux only via web beta), UpNote (no E2EE), Simplenote (development ended Mar 2026), Tot, Antinote, iA Writer, Typora (missing platforms).

Design principle this produced: the only decision a user ever makes about a draft is archive or trash.

## Sync

- **Loro** is the best fit: stable Rust core, UTF-16 text APIs that match CodeMirror offsets, JS bindings, and the `%ELO` E2EE protocol extension, where the server indexes plaintext headers and never decrypts ([spec](https://github.com/loro-dev/protocol/blob/main/protocol-e2ee.md)). Caveats: `%ELO` is protocol v0 and unaudited; `loro-swift` is labeled experimental, so write our own UniFFI layer over the crate.
- Automerge's E2EE work (Keyhive, Subduction) is pre-alpha. secsync has been dormant since 2024. Jazz 2 dropped E2EE by default. Evolu merges last-write-wins per column, which is wrong for text.
- **E2EE pattern:** the server stores opaque, ordered records and clients do all merging and compaction. Argon2id passphrase wraps an account key, which wraps per-draft keys. Enroll devices Bitwarden-style (public-key handoff or QR). Keep the login credential separate from the encryption key.
- **Compaction:** only trim history past a version every device has acknowledged, and keep the previous snapshot until a second device has loaded the new one.
- **iOS freshness:** background refresh and silent push are best-effort (silent push is throttled to a few per hour). Foreground catch-up over a WebSocket is roughly 0.5–1.5s (estimate). We publish our own app, so our server can hold the APNs key directly. A content-free push relay is only needed if other people self-host.
- **Trash:** purging must leave a tombstone that syncs, or an offline device brings the draft back.

## Platform gotchas

- **Wayland has no always-on-top request.** On KDE, float-on-top works through a one-shot KWin script over D-Bus that sets `keepAbove` by pid and caption (`spikes/shell-test/scripts/kwin-keep-above.sh`, verified). It's KDE-only and not a stable API.
- **Global hotkey:** the GlobalShortcuts portal works on Plasma, but it has the silent BindShortcuts bug. Prefer a KDE custom shortcut that runs a CLI, which signals the running app over a unix socket. Forward `XDG_ACTIVATION_TOKEN` so KWin focuses the window instead of flashing the taskbar.
- **Electron hangs before `ready` when no display is connected** (monitor off or asleep), and so does Chrome. Tauri/GTK starts fine. This matters for autostart at login and for anything launched while the screen sleeps.
- **Rich copy:** Electron's `clipboard.write({ html, text })` offers both types. On iOS, write a `UIPasteboard` item with `public.html` plus plain text.
- **iOS quick capture:** one `ControlWidget` covers the Action Button, Lock Screen and Control Center. Land in a native `UITextView` that's already first responder.
- **Testing from Claude's shell:** the Bash sandbox blocks GPU access, so GUI perf tests need the sandbox disabled. Check `qdbus6 org.kde.KWin /KWin org.kde.KWin.supportInformation` for a nonzero screen count first.

## Open questions

- ~~Where the Rust core lives under Electron.~~ Decided: a separate daemon. See [decisions](decisions.md).
- **The hosted "cloud" option.** Deferred. It brings accounts, billing, a push relay and support.
- **Long-term macOS shell.** See [decisions](decisions.md).
