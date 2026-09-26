# Editor binding spike

One question: does the design in [`docs/design.md`](../../docs/design.md#editor-windows) hold up? In that design, each editor window keeps its own Loro copy of a draft, bound to CodeMirror, and trades updates with a Rust daemon over the socket protocol. Concretely:

- Does an agent editing an open draft merge in live without moving your cursor?
- Does undo revert only your own edits?
- Does it survive a daemon restart?
- What does it cost?

**Answer: yes.** Every scenario passes, and the binding adds well under a millisecond per keystroke. The spike found two things the real app has to do differently, both covered in [Findings](#findings).

## Pieces

- **`daemon/`**: a Rust daemon shaped like `scratchpadd`. It speaks line-delimited JSON-RPC on `$XDG_RUNTIME_DIR/scratchpad-spike/daemon.sock` and holds Loro documents with `body` (text) and `meta` (map). It relays updates between windows and snapshots each draft to disk. There's no SQLite, titles or search. The `spike.*` methods exist only to drive the tests: create a draft from a file, run a burst of agent edits, report stats, shut down.
- **`electron/`**: each window gets its own socket connection to the daemon. The main process only pipes lines, and starts the daemon when nothing is listening.
- **`editor/src/`**:
  - `session.ts`: a window's Loro copy. It pushes local updates up, imports the daemon's, and after a reconnect trades only the history each side is missing.
  - `binding.ts`: the CodeMirror to Loro binding, with undo through Loro's `UndoManager`.
  - `scenarios.ts`: the automated checks.
  - The live preview and tables are copied from the shell test.
- **`scripts/history-cost.mjs`**: measures what the `modifiedAt` stamps cost in edit history.

## Running it

```bash
npm install && node node_modules/electron/install.js
npm run fixture && npm run daemon && npm run build
npm run scenarios      # runs everything, writes results/<timestamp>_binding.json, quits
npm start              # manual: HUD buttons simulate an agent, open a second window, restart the daemon
```

Set `SPIKE_ONLY=undoIsolation` (a comma-separated list) to run a subset of the scenarios. Run from a normal terminal with the monitor on; see the shell test's notes on the Claude sandbox and GPU access.

## Results (2026-09-25)

The machine is the same as for the shell test: KDE Plasma 6.7.5 on Wayland, RTX 4080, 240 Hz. The draft is the 100k-word fixture (679k characters, 81 tables). Raw numbers are in `results/`.

| scenario | result |
| --- | --- |
| Binding cost | Keystroke dispatch p50 went from 2.4ms without the binding to 2.8ms with it. Frames held 4.2ms (240 Hz) either way. Each keystroke sends about 91 bytes to the daemon. |
| Agent edits around the cursor | The agent inserts a paragraph at the top, then rewrites a word above and a word below the cursor through `setText`. The 30 characters on each side of the cursor are unchanged, and the cursor moved by exactly the expected 45. The insert showed up in the window in 31ms. The daemon's diff for `setText` on the whole 679k-character draft took 1.4ms and produced a 183-byte update. |
| Undo isolation | Type, the agent appends text, then undo: exactly the typing is removed, the agent's text stays, and the cursor returns to where typing started. Redo restores the typing and leaves the cursor at its end. |
| Typing during an agent storm | 30 agent rewrites, one every 25ms, near the cursor while 121 characters are typed. The typing stays contiguous, all 30 edits arrive, and window and daemon end identical. The daemon's `setText` diffs took 3.9ms p50 and 10ms p95. |
| Second window | Edits typed in one window appear in the other in 18ms p50 and 21ms p95, including a frame. Both windows end identical. |
| Daemon restart | The daemon exits mid-session while the window keeps accepting typing. The window reconnects in 337ms, restarting the daemon itself, and the offline typing reaches the daemon. |
| Load | Opening the draft means a 755 KB snapshot over the socket in 7ms, a Loro import in 13ms, and 26ms to create the editor. First frame lands 275ms after navigation. |
| Loro WASM | 3.3 MB, or 1.1 MB compressed. It's loaded from disk, so its cost shows up only in startup time. |

## Findings

**Undo splits whenever a commit lands mid-typing.** Loro's `UndoManager` closes the current undo group on any commit, even one whose origin is excluded from undo, and on any incoming remote edit.

- The first version stamped `modifiedAt` every 2 seconds while typing, which could split a word's undo group after its first character. Stamps now wait for a 1.5-second pause, or 30 seconds during nonstop typing. A pause already ends an undo group, so a stamp never lands mid-group.
- Remote edits splitting a group is how Loro works: if an agent or another device edits while you type, one Ctrl+Z undoes less than a whole burst. Possible fix: tag each undo step with a timestamp through `onPush`'s `value` and undo adjacent steps together. Not needed for v1.

**Undo after an agent rewrote your text leaves the agent's words behind.** Type "ZEBRA QUAGGA", have the agent change it to "ZEBRA OKAPI", then undo: your characters go and "OKAPI" stays. Each peer's undo only reverts its own operations, so this is correct CRDT behavior, just surprising the first time. It's worth a line in the UI docs rather than a fix.

**We need our own binding; `loro-codemirror` won't do.** Its import handler returns on the first non-text event in a batch. In our design a remote batch often carries a `meta` change alongside the text (the probe saw `["text", "map"]`), so the text edits in that batch would be dropped. It also re-dispatches accumulated changes when a batch has more than one text event. Ours is about 150 lines. It dispatches each text event separately and ignores other containers.

**Loro tags redo commits with origin `"undo"`, the same as undo.** The binding tells them apart through `onPop`'s `isUndo` flag, which fires after the change is applied.

**Stamp cost** (`npm run history-cost`, 18k characters typed with one commit per keystroke):

| stamping | snapshot | after compaction |
| --- | --- | --- |
| none | 2.2 KB | 0.9 KB |
| every 20 keystrokes (about 2 s) | 15.9 KB | 1.0 KB |
| every keystroke | 199 KB | 0.7 KB |

That's about 15 bytes of history per stamp. Stamping on pauses costs even less, and compaction reclaims it. (The absolute sizes are small because the test text repeats and snapshots are compressed.)

**Smaller notes:**
- Remote edits can arrive before `doc.open`'s reply, because the daemon sends the reply after releasing its lock. Loro buffers updates whose dependencies haven't arrived yet, so it's harmless, but the real daemon should send the reply while holding the lock.
- The main process connects only after the page's `did-finish-load`, which costs about 100ms at startup. Connecting when the window is created would win that back.
- Every window session gets a new Loro peer ID, so a draft's version vector grows by one entry per window ever opened on it, at about 12 bytes each. That's fine for years of use. Compaction and stable per-device IDs are the fix if it ever matters.

## Not covered

- **IME composition** (dead keys, compose sequences, input methods) during a remote edit. Doing it by hand: `npm start`, click "Agent: storm near cursor", then type accented characters with a compose key while edits land nearby.
- **Real agent traffic** over the CLI and MCP. The daemon's `setText` path is what they'll use, and it's exercised here.
