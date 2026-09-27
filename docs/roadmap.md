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

## Next

1. **Export.** Export All saves a zip: `Inbox/`, `Archive/` and `Trash/` folders of `.md` files named from each title (made safe for file names, "Untitled" when empty, " 2" on a clash, dated like the draft), plus a `drafts.json` manifest of ids, states and dates so an import could restore them. The files hold the markdown exactly, with no front matter. `scratchpad export <dir>` writes the same layout as a folder (`--zip` for the file), and exporting one draft saves a `.md` named from its title. [`design.md`](design.md) already promises the command.
2. **Daily use.** Use it in place of Drafts on Linux and macOS for a while, and fix what that turns up.
3. **Sync.** A small Rust server that stores opaque, ordered records and never sees plaintext, so it's safe to host anywhere. Clients encrypt with Loro's `%ELO` protocol extension and do all merging and compaction themselves. An Argon2id passphrase wraps an account key, which wraps per-draft keys, and new devices enroll Bitwarden-style, by public-key handoff or QR code. Purged drafts leave tombstones that sync. The background research is in [`research.md`](research.md#sync).
4. **Versions.** Named checkpoints you can go back to, the way Drafts saves a version when you press ⌘S, not every change the CRDT records. Loro keeps the history, so this is mostly deciding when a version is taken and building the browser for them.
5. **iPhone app.** A SwiftUI shell hosting the same editor in a WKWebView, with the Rust core embedded and a native text view for quick capture. The editor and list styles were designed to carry over.

## Pasted images

Not scheduled yet; before or after sync is still open. A pasted or dropped image becomes an attachment: a file beside the drafts named by a hash of its bytes, so the same image is stored once, and never part of a draft's document, so typing stays fast. The markdown holds an ordinary reference (`![screenshot](attachment:3f2a….png)`), which the editor shows as the image except on the line being edited. Export puts images in an `attachments/` folder with relative links, and a single draft with images exports as a zip or TextBundle rather than a bare `.md`. Copy as rich text embeds them in the HTML. Sync carries attachments as separate encrypted blobs, uploaded once and fetched when a draft needs them; one is deleted only when no draft uses it, the Trash included.

## Later

- Settings for the idle rollover time (15 minutes today) and the capture hotkey. There's no settings window yet.
- Selecting several drafts in the sidebar, to archive or trash them together; the prerequisite for merging drafts, if that's ever wanted.
- A compact sidebar option, titles and times only, for anyone who prefers the old density.
- Linux packages (AppImage or pacman) with updates, instead of building from source, and capture-hotkey setup for desktops other than KDE.
- Designs with a place already reserved ([`visual-design.md`](visual-design.md#room-left-for-later)): a sync status indicator, sort options, an actions menu for a draft, and possibly tags or saved searches. None of them should grow into folders.
- Search qualifiers like `in:archive`.
- Icon polish: a hand-hinted 16px icon, and Apple's layered icon format if macOS ever shows ours inside a grey rounded square.
- The long-term macOS shell, which [`decisions.md`](decisions.md) leaves open until the iPhone app exists.
