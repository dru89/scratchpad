# Shell test: Tauri vs Electron

One question: on this machine (KDE Plasma 6.7.5 on Wayland, RTX 4080 + Intel iGPU, webkit2gtk 2.52.6), does the same CodeMirror 6 live-preview editor feel fluid in Tauri (WebKitGTK), or do we need Electron (Chromium)?

Both shells load the identical editor bundle from `editor/` and expose the same bridge (`editor/src/bridge.ts`), so the only differences are the web engine, the IPC, and process overhead.

## What's in the editor

- Live preview that hides markdown syntax outside the element the cursor is in (`livepreview.ts`), computed over the visible ranges only.
- Tables rendered as HTML while the cursor is outside them and as raw markdown while it's inside; clicking a cell puts the cursor at that cell (`tables.ts`). This is SilverBullet's approach.
- A deterministic ~100k-word fixture with 81 tables, including one 300-row table (`fixtures/gen.mjs`).

## Running it

Build once (and after any editor change, since Tauri embeds the bundle):

```bash
npm install && node node_modules/electron/install.js
npm run build
```

Automated pass, all variants, then a summary table in `results/SUMMARY.md`:

```bash
scripts/bench-all.sh
```

Windows will open and scroll on their own for about a minute each. Leave the machine alone while it runs. The monitor has to be on: with no outputs, `requestAnimationFrame` never fires and the run stalls.

One variant, for poking at by hand (the HUD in the corner shows live key-to-frame latency and frame pacing; F2 hides it):

```bash
scripts/run.sh tauri-default
scripts/run.sh electron-wayland
```

Variants: `tauri-default`, `tauri-nodmabuf`, `tauri-nocompositing`, `tauri-x11`, `electron-wayland`, `electron-x11`. See `scripts/run.sh`.

## Manual feel test

The automated numbers only see main-thread work and frame pacing as the engine reports it. They can't see compositor or display latency, so the deciding test is you typing. For `tauri-default` and `electron-wayland`, spend a few minutes on each of these:

1. Click into the middle of a long paragraph and type fast for 30 seconds. Watch for cursor lag or dropped characters.
2. Scroll hard with the wheel or touchpad from top to bottom. Watch for blank regions, stutter, and jumps when tables come into view.
3. Click a table cell, type inside the raw table, then click out and check it re-renders.
4. Paste a large chunk of text.
5. Press the capture hotkey (below) and start typing immediately. Note whether the window gets focus or you have to click it.
6. Click "Float: off" in the HUD, then click another window and check the editor stays on top.
7. Click "Copy rich (native)", then run `wl-paste --list-types` and check for `text/html`. Paste into a rich-text target (Slack, Google Docs) to see how tables survive.

### Capture hotkey

Each shell listens on `$XDG_RUNTIME_DIR/scratchpad-spike.sock`. To test the real hotkey path, add a KDE custom shortcut (System Settings, Keyboard, Shortcuts, Add New, Command) for Meta+Shift+2 that runs:

```
<repo>/spikes/shell-test/scripts/send.sh capture
```

`send.sh` also forwards `XDG_ACTIVATION_TOKEN`; the shell logs whether one arrived.

## Things already learned

- **Run it from a normal terminal.** The Claude Code shell sandbox blocks GPU driver access (`/usr/lib/gbm/dri_gbm.so: Permission denied`), so anything launched from it renders in software.
- **With no displays connected, native-Wayland Electron hangs before `ready`,** and so does Chrome. Tauri/GTK starts fine in the same state. Electron and Obsidian work when launched with the monitor on, so this matters mainly for autostart before the display is up or while it's asleep.
- **The KWin keep-above script works** (`scripts/kwin-keep-above.sh`): it matched and pinned the Electron window by pid and caption.
- **Table typing isn't the bottleneck.** A keystroke costs p95 ≈1.4ms inside the 300-row table and ≈0.6ms in a paragraph (dispatch and DOM update, measured in Chromium).
