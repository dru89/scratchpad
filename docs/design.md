# Design: v1

Scope is the local-only Linux app: the daemon, the CLI and MCP server, and the Electron app. Sync, macOS and iOS come later, and this note only covers them where they constrain choices made now. Decisions and their reasoning live in [decisions.md](decisions.md).

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
| `modifiedAt` | ms timestamp | Stamped by the device where the edit happened, at most every few seconds while typing. The sidebar sorts on it. |
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
- Every connection opens with a version handshake. When the app finds a daemon older than the one it bundles, it asks that daemon to exit and starts its own.
- systemd and launchd socket activation can come later.

**Locations.**

| | Linux | macOS |
| --- | --- | --- |
| Data | `$XDG_DATA_HOME/scratchpad/` | `~/Library/Application Support/dev.unremarkable.scratchpad/` |
| Socket | `$XDG_RUNTIME_DIR/scratchpad/daemon.sock` | the data directory |

The socket directory is `0700` and the socket `0600`.

## Storage

The daemon uses one SQLite database:

- `docs`: the id, the latest Loro snapshot, and its version.
- `doc_updates`: Loro updates since the last snapshot. They're folded into a new snapshot once they pass a size threshold.
- `drafts`: the index used for lists, holding id, state, title, createdAt, modifiedAt and trashedAt.
- `drafts_fts`: an FTS5 table using the trigram tokenizer, over each draft's title and plain text.
- `tombstones`: id and deletedAt.

`drafts` and `drafts_fts` are derived from `docs`. A schema change there means a migration plus a reindex, never a data conversion. A plain markdown export of every draft is always one command away, as a way out.

## Protocol

The daemon speaks JSON-RPC 2.0 over the unix socket, one JSON message per line. MCP is also JSON-RPC, and a line-based protocol is easy to poke at with `socat`. Loro updates travel as base64 strings.

Every connection starts with `hello`:

```json
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"client":{"kind":"app","version":"0.1.0"},"capabilities":["ui"]}}
```

The daemon answers with its own protocol number and version. A client that sends `capabilities: ["ui"]` is the one the daemon forwards UI commands to.

| method | params | result / notes |
| --- | --- | --- |
| `drafts.list` | `state?`, `query?`, `limit?`, `cursor?` | Summaries (id, title, state, modifiedAt, snippet when searching), newest `modifiedAt` first. `query` uses the search index. |
| `drafts.get` | `id` | `meta` plus the body as plain text. For the CLI and agents. |
| `drafts.create` | `text?`, `state?` | `{id}` |
| `drafts.setText` | `id`, `text` | Replaces the body. The daemon diffs old against new and applies only the changed spans, so an agent's edit merges with someone typing in the same draft. |
| `drafts.append` | `id`, `text` | |
| `drafts.setState` | `id`, `state` | |
| `drafts.discard` | `id` | Deletes a draft outright. Refused unless the body is empty. |
| `drafts.render` | `id` or `text`, `format: "html"` | Markdown rendered by comrak with GitHub-style tables, for rich copy. |
| `drafts.subscribe` / `unsubscribe` | | Notifications: `drafts.changed {summary}`, `drafts.removed {id}`. |
| `doc.open` | `id`, `version?` | A snapshot, or the updates since `version`, plus the current version. Starts `doc.update` notifications for that draft. |
| `doc.push` | `id`, `update` | Applies a Loro update from an editor window. |
| `doc.close` | `id` | |
| `ui.capture` | `mode?: "summon" \| "new"`, `draftId?` | Forwarded to the `ui` client. If no app is connected, the daemon launches it with the same arguments. |
| `ui.open` | `id` | Opens the draft in its own window. |

MCP tools map onto these: `list_drafts`, `search_drafts`, `get_draft`, `create_draft`, `update_draft`, `append_to_draft`, `archive_draft`, `trash_draft`, `restore_draft`. No tool deletes permanently.

## Editor windows

Each editor window keeps its own Loro copy of its draft (`loro-crdt` WASM in the renderer), bound to CodeMirror. Keystrokes apply to that copy instantly, and the window exchanges updates with the daemon through `doc.open`, `doc.push` and `doc.update`, the same way devices will exchange them through the sync server.

- **Concurrent edits** from agents, other windows or other devices merge in the CRDT, and CodeMirror moves the cursor along with any text that shifts around it.
- **If the daemon restarts,** the window keeps working and catches up by version on reconnect.
- **Undo** uses Loro's `UndoManager`, so Ctrl+Z reverts only your own edits, never an agent's.

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
| Summon | Meta+Shift+2 | Cmd+Shift+2 | Shows the capture window and applies the idle rule. |
| New draft | Ctrl+N | Cmd+N | Starts a new empty draft now. The window stays open. Also works in the main window. |
| Done | Ctrl+Enter | Cmd+Enter | Keeps the draft in the Inbox, clears and hides the window. The next summon starts fresh regardless of the timer. |
| Load a draft | Ctrl+K | Cmd+K | The quick switcher, opened from the capture window, loads the chosen draft into it and restarts the idle timer. Also available as "Open in capture window" from the sidebar, and as `scratchpad capture --draft <id>`. |
| Pin / unpin | pin button, Ctrl+Shift+P | pin button, Cmd+Shift+P | Stops or resumes the idle rollover for this window only. |
| Dismiss | Esc | Esc | Hides the window. An empty draft is discarded. |

**Hotkey plumbing.**
- On Linux, a KDE custom shortcut runs `scratchpad capture`, which reaches the app through the daemon. KDE's built-in global-shortcut service is unreliable on this Plasma version.
- On macOS, the app registers Cmd+Shift+2 itself with Electron's `globalShortcut` and starts at login.
- `scratchpad capture` works everywhere, so Raycast, Keyboard Maestro or an agent can summon the window too.

**Float.** The capture window floats by default, and any window can toggle it. On KDE that runs the KWin script from the shell test; on macOS it's `setAlwaysOnTop`.

## Search

`drafts.list` with a `query` searches the FTS5 trigram index, so partial words match and "sync" finds "resync". Queries are plain words, all of which must match, plus quoted phrases. Queries shorter than three characters fall back to a title prefix match.

- **Sidebar filter box:** narrows the current list (Inbox, Archive or Trash) as you type.
- **Quick switcher (Ctrl+K, Cmd+K on macOS):** searches every state except Trash. Enter opens the result in the current editor, which is the capture window when opened from there. Ctrl+Enter (Cmd+Enter on macOS) opens it in a new window.
- **Find within a draft:** CodeMirror's search panel.

Qualifiers like `in:archive`, and saved searches as a light form of organization, come later.

## Rich copy

"Copy as rich text" copies the selection, or the whole draft if nothing is selected. The app gets HTML from `drafts.render` and writes both `text/html` and the markdown as `text/plain` to the clipboard.

## Not in v1

Tags, folders, actions, saved searches, sort options other than last modified, sync, and the macOS and iOS apps. The design leaves room for each.

## To prove in the spike

- **Binding CodeMirror to Loro:** remote edits map cleanly into the editor, the cursor holds its place, and IME composition survives concurrent edits.
- **Undo** through Loro's `UndoManager` feels like normal undo.
- **`modifiedAt` stamping:** debounced, and without a meta change per keystroke bloating history.
- **Cost of `loro-crdt` WASM in the renderer:** bundle size, and the load time for a 100k-word draft.
