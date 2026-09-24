# Decisions

Newest first. Each entry says what was decided, why, and what would make us revisit it.

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

- **Core:** Rust (SQLite, Loro CRDT, crypto, sync). With Electron that means either a napi-rs module in the main process, or a separate Rust daemon that owns the store and serves the app, CLI and MCP over a unix socket. The daemon would keep agent access working with the app closed and avoid native-module ABI churn. See [research](research.md#open-questions).
- **iOS:** SwiftUI shell hosting the same editor in a WKWebView, with a native text view for quick capture (a WKWebView can't raise the keyboard without a tap).
- **Sync:** Small Rust server storing opaque encrypted records, using Loro's `%ELO` framing. One Loro document per draft, plus a plaintext markdown copy locally as an escape hatch.
