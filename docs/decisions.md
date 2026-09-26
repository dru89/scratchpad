# Decisions

Newest first. Each entry says what was decided, why, and what would make us revisit it.

## 2026-09-26: Agent edits merge from the version they read

**Decision:** `drafts.get` returns a version, and `drafts.setText` accepts it as `baseVersion`. The daemon forks the draft at that version, applies the new text there as a diff, and merges the result back. `scratchpad edit` and the MCP `update_draft` tool both use it.

**Why:** An agent reads a draft, thinks for a while, then writes back its revision. Diffing that revision against the draft's current text treats everything typed in the meantime as something the agent deleted, so it silently disappears. Branching from what the agent actually read makes its edit behave like one from another device, which the CRDT already merges. The daemon's tests caught this before any real agent did.

**Cost:** about 11 ms per `setText` on a 100k-word draft, against 5 ms without a base. Without `baseVersion`, `setText` still means "replace whatever is there now," for scripts that want that.

**Follow-up, same day:** this is one case of a general rule, now at the top of the design: anything that edits text is a separate device making versioned edits. An editor's copy is only safe to edit from while it matches the version it goes with, so `setText` reports `merged` (whether other edits were combined in), and `drafts.get` accepts `knownVersion` to check for changes without resending the text. The MCP instructions walk agents through read, revise with `base_version`, re-read when `merged` is true.

## 2026-09-25: Capture window text is a regular draft from the first keystroke

**Decision:** The capture window shows an ordinary draft, created on the first keystroke and saved and synced from then on. A draft that's still empty when its window closes is deleted outright. "Done" (Ctrl/Cmd+Enter) keeps the draft and clears the window. The idle rule and pinning apply to the capture window independently of the main window. Details are in [design.md](design.md#windows).

**Why:** In Drafts, the capture window is a separate buffer that only becomes a draft when you save. Until then its text isn't synced, isn't visible to agents, and is lost if the app crashes, and it's a second kind of object with its own rules. A third option, hiding capture drafts from the Inbox until they're filed, brought back a special state. Creating the draft lazily and discarding empty ones keeps what's good about Drafts, which is that summoning and dismissing leaves nothing behind.

**Revisit if:** half-finished captures clutter the Inbox in practice.

## 2026-09-23: The core runs as its own process

**Decision:** A Rust daemon (`scratchpadd`, working name) owns the SQLite store, the Loro documents, the keys and the sync connection. The Electron app, the CLI, and the MCP server (`scratchpad mcp`, over stdio) are all clients of one local socket protocol. On iOS the same Rust library runs in-process.

**Why:**
- Agents and the CLI work with the app closed.
- The same binary runs headless on ds9 as the replica remote agents can reach.
- There's one API surface, and no napi-rs module to rebuild for every Electron release.
- There's one writer to the store.

**Costs accepted:**
- Lifecycle: the app spawns the daemon when it can't connect; systemd and launchd socket activation can come later.
- A version handshake on every connection, with the app restarting an outdated daemon.
- Reconnect and keystroke buffering in the app.
- A second binary to bundle and sign.
- A long-running process holding decrypted keys.

## 2026-09-23: Desktop shell is Electron

**Decision:** Build the desktop app (Linux and, for now, macOS) on Electron. The editor stays behind `bridge.ts`-style shell abstraction so this can change later.

**Why:** The [shell test](../spikes/shell-test/README.md) on the primary machine (KDE Plasma 6.7.5 Wayland, RTX 4080, 240 Hz 4K):

- Stock Tauri crashes at launch with `Error 71 (Protocol error)`, the NVIDIA DMA-BUF bug. The env-var workarounds start but hold only 70–85 fps under load.
- Electron holds the full 236–240 fps while typing and scrolling a 100k-word document, and its JavaScript engine does about half the work per keystroke (3.3 vs 6.0ms p95).
- Tauri's wins were smaller than advertised: about 150 MB less memory; launch-to-first-frame was the same (~400ms).

**Revisit if:** WebKitGTK 2.54 (Skia compositor by default) fixes the NVIDIA path, or Tauri's CEF (Chromium) backend ships stable. Rerun `spikes/shell-test/scripts/bench-all.sh` to check.

## 2026-09-23: The macOS shell is deferred

**Decision:** Use the Electron build on macOS for now. Decide the long-term Mac shell after the iOS app exists.

**Why:** On macOS, Tauri's handicap disappears (it uses WKWebView, and macOS 26 reportedly removed the 60 fps cap). The more interesting alternative is a macOS target of the iOS SwiftUI + WKWebView shell: same engine as the phone, `NSPanel` for floating windows, native hotkeys and Control Center widgets. That keeps two shells total (Swift for Apple, Electron for Linux) but means building the desktop window features twice. Electron's Mac build is nearly free, so there's no cost to waiting until the iOS shell shows how much would carry over.

## 2026-09-22: Editor is CodeMirror 6 with markdown as the only source of truth

**Decision:** CodeMirror 6 live preview. Syntax is hidden outside the element holding the cursor. Tables render as HTML while the cursor is outside them and fall back to raw markdown inside (SilverBullet's approach); Zettlr-style per-cell editors can come later.

**Why:** CM6 renders only the viewport, so large drafts stay fast (a keystroke inside a 300-row table cost ~1.4ms). ProseMirror, Tiptap, Lexical and BlockNote regenerate markdown from a tree and all have open round-trip bugs. Since every draft ends by being copied out, the text has to stay exactly as typed. One web editor also runs on all three platforms, while going native would mean building live preview twice.

## Proposed, not yet decided

- **iOS:** SwiftUI shell hosting the same editor in a WKWebView, with a native text view for quick capture (a WKWebView can't raise the keyboard without a tap).
- **Sync:** Small Rust server storing opaque encrypted records, using Loro's `%ELO` framing. One Loro document per draft, plus a plaintext markdown copy locally as an escape hatch.
