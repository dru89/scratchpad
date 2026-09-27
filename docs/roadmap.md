# Roadmap

Where scratchpad stands and what comes next. [`design.md`](design.md) covers how the pieces work, and [`decisions.md`](decisions.md) why they're built that way.

## Done

1. **Design.** [`design.md`](design.md) for behavior, [`visual-design.md`](visual-design.md) for the look.
2. **Editor binding spike.** [`spikes/editor-binding`](../spikes/editor-binding/): each window keeps a Loro copy of the draft bound to CodeMirror, agent edits merge live, and undo stays local.
3. **Daemon, CLI and MCP server.** [`crates/`](../crates/): agents could use drafts before there was a UI.
4. **The desktop app on Linux.** [`app/`](../app/), developed on KDE Plasma on Wayland.
5. **The desktop app on macOS.** The same app, signed and notarized in CI, with its own capture hotkey.

## Next

1. **Daily use.** Use it in place of Drafts on Linux and macOS for a while, and fix what that turns up.
2. **Sync.** A small Rust server that stores opaque, ordered records and never sees plaintext, so it's safe to host anywhere. Clients encrypt with Loro's `%ELO` protocol extension and do all merging and compaction themselves. An Argon2id passphrase wraps an account key, which wraps per-draft keys, and new devices enroll Bitwarden-style, by public-key handoff or QR code. Purged drafts leave tombstones that sync. The background research is in [`research.md`](research.md#sync).
3. **iPhone app.** A SwiftUI shell hosting the same editor in a WKWebView, with the Rust core embedded and a native text view for quick capture. The editor and list styles were designed to carry over.

## Later

- An Intel Mac build, which needs x86_64 builds of the Rust binaries in the bundle.
- Linux packages instead of building from source, and capture-hotkey setup for desktops other than KDE.
- Auto-update.
- Settings for the idle rollover time (15 minutes today) and the capture hotkey.
- A hand-hinted 16px app icon.
- Designs with a place already reserved ([`visual-design.md`](visual-design.md#room-left-for-later)): a sync status indicator, sort options, an actions menu for a draft, and possibly tags or saved searches. None of them should grow into folders.
- Search qualifiers like `in:archive`.
- The long-term macOS shell, which [`decisions.md`](decisions.md) leaves open until the iPhone app exists.
