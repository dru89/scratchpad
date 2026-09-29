# Roadmap

Where scratchpad stands and what comes next. [`design.md`](design.md) covers how the pieces work, and [`decisions.md`](decisions.md) why they're built that way.

## Done

1. **Design.** [`design.md`](design.md) for behavior, [`visual-design.md`](visual-design.md) for the look.
2. **Editor binding spike.** [`spikes/editor-binding`](../spikes/editor-binding/): each window keeps a Loro copy of the draft bound to CodeMirror, agent edits merge live, and undo stays local.
3. **Daemon, CLI and MCP server.** [`crates/`](../crates/): agents could use drafts before there was a UI.
4. **The desktop app on Linux.** [`app/`](../app/), developed on KDE Plasma on Wayland.
5. **The desktop app on macOS.** The same app, signed and notarized in CI, with its own capture hotkey, and updates from GitHub Releases. Apple silicon only, since current macOS no longer runs on Intel Macs.
6. **Links and the Draft menu.** `scratchpad://` links, copying a draft's link, ID, title or contents, Duplicate, Get Info and Empty Trash.
7. **Sidebar previews.** Each row shows two lines of the text after the title, and the sidebar resizes.
8. **Export.** Every draft as markdown in a zip or folder, with a manifest; one draft as a `.md` file.
9. **Pasted images.** Pasted and dropped images are stored once beside the drafts and shown in place, and they go along in exports, rich copy and to agents ([`design.md`](design.md#attachments)).
10. **Global hotkeys that toggle, and pasting formatted text.** ⌘⇧1 and ⌘⇧2 show or hide the main and capture windows, the capture window is a panel on macOS, and pasted HTML becomes markdown ([`design.md`](design.md#pasting)).

## Next

1. **Daily use.** Use it in place of Drafts on Linux and macOS for a while, and fix what that turns up.
2. **Sync.** A small Rust server that stores opaque, ordered records and never sees plaintext, so it's safe to host anywhere. Clients encrypt with Loro's `%ELO` protocol extension and do all merging and compaction themselves. An Argon2id passphrase wraps an account key, which wraps per-draft keys, and new devices enroll Bitwarden-style, by public-key handoff or QR code. Purged drafts leave tombstones that sync. The background research is in [`research.md`](research.md#sync).
3. **Versions.** Named checkpoints you can go back to, the way Drafts saves a version when you press ⌘S, not every change the CRDT records. Loro keeps the history, so this is mostly deciding when a version is taken and building the browser for them.
4. **iPhone app.** A SwiftUI shell hosting the same editor in a WKWebView, with the Rust core embedded and a native text view for quick capture. The editor and list styles were designed to carry over.

## Later

- Settings for the idle rollover time (15 minutes today) and the capture hotkey. There's no settings window yet.
- Selecting several drafts in the sidebar, to archive or trash them together; the prerequisite for merging drafts, if that's ever wanted.
- A compact sidebar option, titles and times only, for anyone who prefers the old density.
- Linux packages (AppImage or pacman) with updates, instead of building from source, and capture-hotkey setup for desktops other than KDE.
- Designs with a place already reserved ([`visual-design.md`](visual-design.md#room-left-for-later)): a sync status indicator, sort options, an actions menu for a draft, and possibly tags or saved searches. None of them should grow into folders.
- Search qualifiers like `in:archive`.
- Images embedded in pasted HTML (as `data:` URLs) stored as attachments instead of left out.
- More for images: showing an image that shares a line with text, showing a Retina screenshot at the size it was on screen, Copy Image and dragging one out, a TextBundle export for apps that read it, and a way for the CLI and agents to add one.
- Icon polish: a hand-hinted 16px icon, and Apple's layered icon format if macOS ever shows ours inside a grey rounded square.
- The long-term macOS shell, which [`decisions.md`](decisions.md) leaves open until the iPhone app exists.
