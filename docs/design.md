# Design: v1

Scope is the local-only Linux app: the daemon, the CLI and MCP server, and the Electron app. Sync, macOS and iOS come later, and this note only covers them where they constrain choices made now. Decisions and their reasoning live in [decisions.md](decisions.md).

## Every editor is a device

Anything that can change a draft's text is treated as a separate device making versioned edits: each editor window, other computers and phones, the CLI, and agents. Nothing overwrites a draft. A client that wants to replace text says which version that text came from, and its change is merged with everything written since, so the result can differ from what it sent. The protocol tells it when that happened, so it knows to read again before its next edit.

## Drafts

A draft is one Loro document, identified by a ULID. ULIDs can be generated offline on any device and sort by creation time.

The document has two parts:

- `body`: a `LoroText` holding the markdown.
- `meta`: a `LoroMap` with:

| key | type | notes |
| --- | --- | --- |
| `schema` | int | Starts at 1. Bumped only for changes old clients would misread. |
| `state` | `"inbox"` \| `"archived"` \| `"trashed"` | |
| `createdAt` | ms timestamp | |
| `modifiedAt` | ms timestamp | Stamped by the device where the edit happened, after a 1.5 s pause in typing (or every 30 s during nonstop typing). Stamping mid-burst would split the undo group. The sidebar sorts on it. |
| `trashedAt` | ms timestamp or null | Set when trashed, cleared on restore. |

**Room to grow.** Anything added later (tags, a folder, a flag, fields an action needs) is a new key in `meta`. Clients ignore keys they don't recognize and never delete them. Tags, if they arrive, are a `LoroMap` of tag to `true` rather than a list, so adding tags on two devices at once merges cleanly.

**Titles** are computed from the body, never stored. The rules:
- Parse the start of the body as markdown and take the first line that has text.
- Strip its syntax: heading markers, emphasis, list and quote markers, link URLs and backticks.
- Skip lines with no text, such as code fences, horizontal rules and table divider rows.
- Trim, and cut at about 80 characters.

`# Title` becomes "Title" and `**Idea:** thing` becomes "Idea: thing". An empty draft shows as "New draft". The daemon computes titles so the app, CLI and agents all see the same ones.

### States

- Inbox and Archived switch freely.
- Any draft can be trashed, which sets `trashedAt`.
- Restoring from Trash returns a draft to the Inbox.
- Trashed drafts are purged 30 days after `trashedAt`. The daemon checks on startup and then hourly.

**Empty drafts** never clutter the list:
- A draft is created on the first keystroke, not when a window opens.
- If a draft's body is empty or whitespace when its last window closes or rolls over, it's deleted outright, skipping Trash.

**Tombstones.** A purge or an outright delete leaves a record of `{id, deletedAt}`, so a device that was offline doesn't bring the draft back. Once sync exists, a tombstone can be dropped after every enrolled device has synced past it, the same rule that governs compacting edit history.

## Processes

| process | role |
| --- | --- |
| `scratchpadd` | Rust daemon. The only writer to the store. Holds the Loro documents, computes titles, maintains the search index, runs the trash purge, and later holds keys and the sync connection. |
| `scratchpad` | Rust CLI, a thin client of the daemon. `scratchpad mcp` runs an MCP server over stdio for agents. |
| Electron app | The main process is a daemon client for lists, metadata and UI commands. Each editor window holds its own Loro copy of its draft (see [Editor windows](#editor-windows)). |

**Lifecycle.**
- A client that can't connect spawns the daemon. An `flock` on a lock file stops two clients from starting two daemons.
- The daemon outlives the app, so an update can leave an old one running. Two things replace it:
  - The daemon checks its own binary every two seconds and exits cleanly once an install has replaced it (`cargo install`, a new app bundle). Clients reconnect and start the new one, and the app's windows catch up by version.
  - Every connection opens with a `hello` that carries the client's version. A client that finds an older daemon asks it to exit and starts its own: the one bundled with the app, or the one beside the CLI. It does this once per run, and it never replaces a newer daemon, so an old CLI left on the PATH can't downgrade the app's. A newer daemon is refused only if its protocol changed.
- The Rust workspace and the app share one version, set by `scripts/bump-version.sh` and checked in CI.
- systemd and launchd socket activation can come later.

**Locations.**

| | Linux | macOS |
| --- | --- | --- |
| Data | `$XDG_DATA_HOME/scratchpad/` | `~/Library/Application Support/dev.unremarkable.scratchpad/` |
| Socket | `$XDG_RUNTIME_DIR/scratchpad/daemon.sock` | the data directory |

The data and socket directories are `0700` and the socket `0600`.

## Storage

The daemon uses one SQLite database (WAL mode):

- `docs`: the id and the latest Loro snapshot.
- `doc_updates`: every Loro update since that snapshot, one row per change, so a keystroke's worth of typing is on disk before its reply goes out. A draft's updates are folded into a new snapshot after 500 of them or 512 KB.
- `drafts`: the index used for lists, holding id, state, title, preview (the text after the title, stripped of markdown), createdAt, modifiedAt and trashedAt.
- `drafts_fts`: an FTS5 table using the trigram tokenizer, over each draft's title and plain text.
- `tombstones`: id and deletedAt.
- `attachment_orphans`: each attachment no draft uses, and since when (see [Attachments](#attachments)). Older versions never read it, so it didn't change the schema version.

Pasted images are files in `attachments/` beside the database, not rows.

`drafts` and `drafts_fts` are derived from `docs`, and the daemon rebuilds them on startup if the counts disagree. A schema change there means a migration plus a reindex, never a data conversion. A plain markdown export of every draft is always one command away, as a way out (see [Export](#export)).

**Reindexing** happens once a draft's edits pause for 400 ms, or at most 2 s after the first unindexed edit. `drafts.list` flushes anything pending first, so a list or search always reflects edits already acknowledged. When only metadata changed, for example an archive or a `modifiedAt` stamp, the search index is left alone. Rewriting it costs about 45 ms for a 100k-word draft.

Drafts stay loaded in memory while a window has them open, and for 10 minutes after the last use.

## Protocol

The daemon speaks JSON-RPC 2.0 over the unix socket, one JSON message per line. MCP is also JSON-RPC, and a line-based protocol is easy to poke at with `socat`. Loro updates and versions travel as base64 strings.

Every connection starts with `hello`:

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"client":{"kind":"app","version":"0.1.0"},"capabilities":["ui"]}}
```

The daemon answers with its protocol number, version and pid. A client that sends `capabilities: ["ui"]` is one the daemon forwards UI commands to; the most recent one wins.

Every `id` parameter accepts a full id or any unique prefix of one, case-insensitively.

| method | params | result / notes |
| --- | --- | --- |
| `drafts.list` | `states?` (default `["inbox"]`), `query?`, `limit?` (default 100), `cursor?` | Summaries (id, title, preview, state, createdAt, modifiedAt, trashedAt, and a snippet when searching), newest `modifiedAt` first, plus `nextCursor` when there's more. |
| `drafts.get` | `id`, `knownVersion?` | The summary, the body as plain text, the whole `meta` map, and `version`. If `knownVersion` matches the current version, the reply is the summary plus `unchanged: true`, without the text. |
| `drafts.create` | `text?`, `state?` | The new draft's summary and `version`. |
| `drafts.setText` | `id`, `text`, `baseVersion?` | Replaces the body with a minimal diff. With `baseVersion` (from `drafts.get`), the diff is taken against that version and merged, so text written since, by you in the app, say, survives an agent's revision. Without it, the text replaces whatever the draft holds now. Returns the new `version` and `merged`: `false` means the draft is now exactly the caller's text and the version can be used for its next edit; `true` means other edits were combined in, so the caller should read again. |
| `drafts.append` | `id`, `text`, `ensureNewline?` | With `ensureNewline`, the text starts on a new line if the draft doesn't already end with one. The CLI and MCP tool set it. |
| `drafts.setState` | `id`, `state` | Doesn't change `modifiedAt`. |
| `drafts.discard` | `id` | Deletes a draft outright. Refused unless the body is empty. |
| `drafts.emptyTrash` | | Deletes everything in the Trash now and returns `deleted`, the count. The app asks first; the CLI and MCP server don't offer it. |
| `drafts.export` | `path` (absolute), `zip?`, `overwrite?`, `id?` | Writes every draft as markdown (see [Export](#export)) to a new or empty folder, or with `zip` to a zip file, replacing an existing one only with `overwrite`. With `id`, writes only that draft and its images. Returns `drafts`, the count. Not offered to agents. |
| `drafts.render` | `id` or `text` | `{html}`: GitHub-flavored HTML with raw HTML dropped, for rich copy. Attachments are inlined as `data:` URLs. |
| `attachments.add` | `data` (base64) | Stores an image and returns its `name` and `size`. The same bytes always get the same name. PNG, JPEG, GIF and WebP up to 32 MB; anything else is an invalid-params error. |
| `attachments.get` | `name` | `{name, type, data}`, the image as base64. For the MCP server; windows read the files directly. |
| `drafts.subscribe` / `unsubscribe` | | Notifications: `drafts.changed {summary}`, `drafts.removed {id}`. |
| `doc.open` | `id`, `version?` (a version vector) | A snapshot, or the updates since `version`, plus the daemon's version vector. Starts `doc.update {id, update}` notifications for that draft. One task handles every request in order, so the reply always reaches the client before any update for that draft. |
| `doc.push` | `id`, `update` | Applies a Loro update from an editor window and relays it to the draft's other windows. Updates the daemon already has are ignored. |
| `doc.close` | `id` | Stops updates. A deleted draft's windows get `doc.removed {id}`. |
| `ui.capture` | `mode?: "summon" \| "new" \| "toggle"`, `draftId?`, `activationToken?` | Forwarded to the app. `toggle` summons the capture window, or hides it if it's the focused window. With no app connected this fails with "the app isn't running", and the CLI starts it. |
| `ui.open` | `id` | Opens the draft in its own window. |
| `ui.main` | `toggle?`, `activationToken?` | Shows the main window, or with `toggle`, hides it if it's the focused window. |
| `daemon.status` | | Version, pid, uptime, counts of clients, loaded drafts and drafts. |
| `daemon.shutdown` | | Replies, then exits. |

Errors use JSON-RPC codes plus `-32001` no such draft, `-32002` ambiguous id (with `data.candidates`), `-32003` discard refused because the draft isn't empty, and `-32004` no app connected.

**CLI.** `scratchpad` covers `list`, `search`, `show`, `new`, `append`, `set`, `edit`, `archive`, `trash`, `restore`, `render`, `capture`, `open` and `daemon start|status|stop`, with `--json` on everything. `edit` opens `$VISUAL`/`$EDITOR` and writes back with `baseVersion`, so typing done in the app while the editor was open is kept.

**MCP.** `scratchpad mcp` offers `list_drafts`, `search_drafts`, `get_draft`, `get_image`, `create_draft`, `update_draft`, `append_to_draft`, `archive_draft`, `trash_draft` and `restore_draft`. Its instructions tell agents they're one editor among several: read with `get_draft`, send revisions with that version as `base_version`, re-read when a result says `merged: true`, and use `known_version` to check cheaply for changes. They also say what an `attachment:` reference is, that `get_image` shows one, and to keep the references when editing. No tool deletes permanently.

## Editor windows

Each editor window keeps its own Loro copy of its draft (`loro-crdt` WASM in the renderer), bound to CodeMirror. Keystrokes apply to that copy instantly, and the window exchanges updates with the daemon through `doc.open`, `doc.push` and `doc.update`, the same way devices will exchange them through the sync server.

- **Concurrent edits** from agents, other windows or other devices merge in the CRDT, and CodeMirror moves the cursor along with any text that shifts around it.
- **If the daemon restarts,** the window keeps working and catches up by version on reconnect.
- **Tab** in a list makes each selected item a child of the item above it, re-indenting it with spaces to where that item's text starts, and Shift+Tab moves it back out to its parent's level. An item's children move with it. Anywhere else, Tab inserts a tab or indents every selected line. Lines in fenced code are never treated as list items ([`app/src/editor/indent.ts`](../app/src/editor/indent.ts)).
- **Undo** uses Loro's `UndoManager`, so Ctrl+Z reverts only your own edits, never an agent's. Undo restores the selection saved as Loro cursors, and redo leaves the cursor at the end of what it restored. A remote edit that arrives mid-typing splits the undo group; merging adjacent steps is a later refinement.
- **The binding is our own**, about 150 lines. The published `loro-codemirror` drops text changes that share a batch with a `meta` change.

## Windows

There are three kinds:

| window | contents | idle rule | pin |
| --- | --- | --- | --- |
| Main | Sidebar (Inbox, Archive, Trash, filter box) and an editor | yes | its own |
| Capture | Editor only. Floats on top, summoned by the hotkey | yes | its own |
| Draft | Editor only, opened for a specific draft | no; always stays on its draft | not needed |

Window state (current draft, pinned, when the draft was loaded, float) is local to the device. The app persists it; it doesn't sync.

**The idle rule.**
- It's checked only when a main or capture window is summoned (hotkey, or clicking the app), never while it's on screen.
- If the window isn't pinned and the later of the draft's `modifiedAt` and the moment it was loaded into this window is more than 15 minutes ago, the window opens on a new empty draft.
- The old draft stays in the Inbox, or is deleted if it was empty.
- 15 minutes is a default for now and becomes a setting later.

**Pinning** keeps a window on its current draft until unpinned. The main and capture windows each have their own pin, and neither affects the other.

### Capture window actions

| action | Linux | macOS | effect |
| --- | --- | --- | --- |
| Summon | Meta+Shift+2 | Cmd+Shift+2 | Shows the capture window and applies the idle rule. When the capture window is already the focused window, the same keys hide it. |
| New draft | Ctrl+N | Cmd+N | Starts a new empty draft now. The window stays open. Also works in the main window. |
| Done | Ctrl+Enter | Cmd+Enter | Keeps the draft in the Inbox, clears and hides the window. The next summon starts fresh regardless of the timer. |
| Load a draft | Ctrl+K | Cmd+K | The quick switcher, opened from the capture window, loads the chosen draft into it and restarts the idle timer. Also available as "Open in capture window" from the sidebar, and as `scratchpad capture --draft <id>`. |
| Pin / unpin | pin button, Ctrl+Shift+P | pin button, Cmd+Shift+P | Stops or resumes the idle rollover for this window only. |
| Dismiss | Esc | Esc | Hides the window. An empty draft is discarded. |

### Other shortcuts

Ctrl on Linux, Cmd on macOS.

| action | keys |
| --- | --- |
| Float on top | Ctrl+Shift+F |
| Copy as rich text | Ctrl+Shift+C |
| Archive / move to Inbox | Ctrl+Shift+A |
| Trash / restore | Ctrl+Shift+Backspace |
| Open the draft in its own window | Ctrl+Shift+O |
| Get info: place, dates, length, ID and link | Ctrl+I |
| Toggle the sidebar | Ctrl+\ |
| Inbox / Archive / Trash | Ctrl+1 / Ctrl+2 / Ctrl+3 |
| Filter the sidebar | Ctrl+Shift+L |
| Find in the draft | Ctrl+F |
| Find and replace | Ctrl+H (Cmd+Option+F on macOS, where Cmd+H hides the app) |
| Nest a list item under the one above, or move it back out | Tab, Shift+Tab |

Archiving or trashing from the main or capture window moves that window on to a new draft; a draft's own window stays on it and shows a badge.

Closing the main or capture window hides it, so the app keeps running for the hotkey; Ctrl+Q quits. Launching the app again shows the main window, and so does Meta+Shift+1 (Cmd+Shift+1 on macOS) from anywhere, which hides it again when it's the focused window.

**The Draft menu** in the menu bar has these actions for the focused window's draft, plus Duplicate and a Copy submenu (Contents, Title, Link, ID). The sidebar's context menu has the same for any draft: open in a new or the capture window, archive or trash, Duplicate, Get Info, Copy (Contents, Rich Text, Title, Link, ID), and on the Trash tab, Empty Trash. Duplicate makes a new Inbox draft with the same text and opens it. The window carries out every action, so the keys and the menu go through the same code; on macOS the menu takes the keys, and on Linux it only shows them.

**Links.** `scratchpad://open/<id>` opens a draft in its own window, and `scratchpad://capture` summons the capture window. The CLI's `--json` output and the MCP results include each draft's link as `url`, and `scratchpad link <id>` prints one. macOS registers the scheme from the app bundle and delivers links through `open-url`; on Linux the install script makes the desktop entry the handler, and links arrive on the command line.

**Hotkey plumbing.** Both hotkeys toggle: each shows its window, or hides it when it's the focused window. A window that's showing but not focused, like a floating capture window you've typed past, comes forward instead.
- On Linux, KDE custom commands run `scratchpad capture --toggle` and `scratchpad open --toggle`, which reach the app through the daemon. KDE's portal-based global shortcuts are unreliable on this Plasma version; a custom command doesn't use the portal. The app then focuses the window through KWin, since Wayland won't let it take focus itself.
- If the app isn't running, `scratchpad capture` (and `scratchpad open`) start it with `scratchpad-app --capture` (or `--open=<id>`, or nothing for the main window).
- On macOS, the app registers Cmd+Shift+1 and Cmd+Shift+2 itself with Electron's `globalShortcut` and starts at login (the app menu's Open at Login turns that off). The capture window is a panel (`type: 'panel'`), like Spotlight's: it takes the keyboard without making scratchpad the active app, so the main window stays behind whatever you were using, and hiding the panel puts you back there. It also comes up over full-screen apps and on every Space. When scratchpad is hidden, which happens when its last window closes so focus can go back where it was, summoning the panel unhides the app first.
- `scratchpad capture` works everywhere, so Raycast, Keyboard Maestro or an agent can summon the window too.

**Float.** The capture window floats by default, and any window can toggle it. On KDE that runs the KWin script from the shell test; on macOS it's `setAlwaysOnTop`.

## Search

`drafts.list` with a `query` searches the FTS5 trigram index, so partial words match and "sync" finds "resync". Queries are plain words, all of which must match, plus quoted phrases. Queries shorter than three characters fall back to a title prefix match.

Each result carries a snippet: a line of plain text around the first match outside the title line, since the title is already shown above it. When only the title matches, the snippet starts there. The daemon reads the markdown around it, strips each line the way titles are stripped (table rows become their cells, joined with commas), joins the lines with " · ", and cuts about 40 bytes before the match and 80 after, between words. Fenced code is kept as written. The app highlights the matched words itself.

- **Sidebar filter box:** narrows the current list (Inbox, Archive or Trash) as you type.
- **Quick switcher (Ctrl+K, Cmd+K on macOS):** searches every state except Trash. Enter opens the result in the current editor, which is the capture window when opened from there. Ctrl+Enter (Cmd+Enter on macOS) opens it in a new window.
- **Find within a draft:** a slim panel over CodeMirror's search ([`app/src/editor/find.ts`](../app/src/editor/find.ts)), with replace on Ctrl+H. A rendered table marks its own matches, because CodeMirror's highlighting can't reach inside the widget.

Qualifiers like `in:archive`, and saved searches as a light form of organization, come later.

## Attachments

A pasted or dropped image becomes an attachment ([`crates/core/src/attachments.rs`](../crates/core/src/attachments.rs)), and the draft gets an ordinary markdown image that refers to it:

```markdown
![](attachment:3f2a9c0e1b7d4a6f8e2c5b9d0a1f3e7c.png)
```

- **Storage.** The file lives in `attachments/` in the data folder, named by the first 128 bits of the SHA-256 of its bytes, so the same image is stored once however many drafts use it. The daemon writes it beside its final name and renames it into place. The bytes never go into the draft's Loro document, which keeps typing, syncing and history as cheap as they were.
- **Formats.** PNG, JPEG, GIF and WebP, which every place a draft is shown can display, up to 32 MB. The daemon goes by the bytes, not the name or claimed type. Nothing is looked up on disk unless its name is 32 hex digits and one of those extensions.
- **In the editor** ([`editor/images.ts`](../app/src/editor/images.ts)). Pasting an image (when the clipboard holds no text other than the file's own name, since spreadsheets put a picture beside the cells they copy) or dropping one sends it to `attachments.add` and inserts the reference on a line of its own, with the cursor on the line after. A line that's only an attachment image shows as the picture: its natural size, capped at the text width and a maximum height. On the line being edited, the markdown shows above the picture instead of replacing it, so the picture doesn't jump away while the cursor passes. Up and Down step onto that line rather than over the picture, and clicking the picture puts the cursor there too. An image elsewhere in a line stays as markdown.
- **Serving.** Windows load `attachment:<name>` through a custom protocol the app registers, straight from the folder; the page's content security policy allows that scheme for images and nothing else.
- **Cleanup.** An attachment is kept while any draft refers to it, the Trash included. The hourly sweep that empties the Trash also finds attachments nothing refers to, notes the time in `attachment_orphans`, and deletes them 30 days later unless something refers to them again by then. The grace period covers undoing a deleted image, and a draft's text coming back from an export.
- **Everywhere else.** Export copies the images a draft uses (see [Export](#export)). Rich copy inlines them. The MCP server's `get_image` shows one to an agent.
- **Sync, later.** Attachments will travel as separate encrypted blobs, uploaded once and fetched when a draft needs them, under a keyed hash rather than the plain content hash, so the server can't test whether you have a known image.

## Export

An export is every draft as markdown, in the layout an import could read back:

- `Inbox/`, `Archive/` and `Trash/`, one `.md` file per draft holding its markdown exactly, with no front matter.
- Files are named from the title, made safe for macOS, Linux and Windows: no path separators, reserved or control characters, no leading dots, 80 characters at most, and "Untitled" when nothing is left. When two drafts in a folder would share a name (ignoring case), the older one gets " 2". Each file is dated with its draft's `modifiedAt`.
- `attachments/` holds the images the drafts use, and each draft's references are rewritten to relative links (`../attachments/<name>`), so any markdown app shows them.
- `drafts.json` lists each draft's id, title, state, file, the attachments it uses, and created, modified and trashed times.

The daemon writes it ([`crates/core/src/export.rs`](../crates/core/src/export.rs)), taking open drafts from memory so the latest typing is in it. `scratchpad export <dir>` writes a folder, which has to be new or empty, and `--zip` a zip (`--force` to replace one). In the app, File > Export All… saves a zip, `scratchpad-<date>.zip` by default. Export… in the Draft menu and the sidebar's context menu saves one draft as a `.md` file, named the same way. A draft with images saves as a zip instead, holding the `.md` and an `attachments/` folder beside it.

## Rich copy

"Copy as rich text" copies the selection, or the whole draft if nothing is selected. The app gets HTML from `drafts.render` and writes both `text/html` and the markdown as `text/plain` to the clipboard. Images go in the HTML as `data:` URLs, so they arrive in apps that accept pasted pictures.

## Pasting

Pasting formatted text writes markdown ([`editor/richpaste.ts`](../app/src/editor/richpaste.ts)). The clipboard's HTML is read for headings, bold, italics, strikethrough, links, inline and fenced code, quotes, rules, lists (nested, numbered and tasks) and tables, so a copy from Google Docs, Word, Slack, Confluence or a web page arrives as the markdown the editor already shows.

- **Formatting comes from styles as well as tags.** Google Docs marks bold with `font-weight` and wraps a whole copy in `<b style="font-weight:normal">`, so a style wins over its tag. Word's lists are paragraphs with `mso-list` styles, and they come out as lists.
- **Structure follows how the page renders.** Paragraphs are separated by a blank line and `<div>`s by a line break. A table with two columns or more becomes a markdown table with its first row as the header. A one-column table, or one holding other tables, is layout, as in an email, and becomes its text. Nested lists step in with a tab, like the editor's own.
- **Only text that would read as markdown is escaped**, since every backslash shows: `*` and `_` where they could make emphasis, a line that would start a heading, list or quote, and so on. `5 * 3` and `snake_case` stay as they are.
- **Remote images keep their link** as markdown; images embedded in the HTML are left out rather than buried in base64.

The plain text is pasted instead when the HTML adds nothing, and whenever the formatting isn't the point:

- the cursor is in code, fenced or inline;
- everything copied is code, as a code editor or terminal copies it (monospace or preformatted), where the plain text is exactly what was selected;
- the HTML is scratchpad's own Copy as Rich Text, whose plain text is the draft's markdown;
- the converted text reads the same as the plain text, apart from escapes and spacing.

Paste and Match Style (⌥⇧⌘V on macOS, Paste as Plain Text and Ctrl+Shift+V on Linux) always pastes the plain text.

## Not in v1

Tags, folders, actions, saved searches, sort options other than last modified, sync, and the macOS and iOS apps. The design leaves room for each.

## Proven in the spike

[`spikes/editor-binding`](../spikes/editor-binding/README.md) passed every scenario against the 100k-word draft:
- Agent edits merge around the cursor without moving it.
- Undo reverts only your own edits.
- Two windows stay in sync, 18 ms apart.
- The window survives a daemon restart, and typing done while it was down reaches the daemon.

The binding adds about 0.4 ms per keystroke with no dropped frames at 240 Hz, and opening the draft costs about 45 ms of socket, import and editor setup. Composing characters with an input method or compose key while an agent edit lands is still untested.
