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

## Results: 2026-09-23

Display: DP-3, 3840×2160 at 1.45× scale, 240 Hz, so a frame is 4.2ms. Full numbers are in [`results/SUMMARY.md`](results/SUMMARY.md), raw runs in `results/*.json`.

| variant | typing fps | scroll fps | keystroke JS p95 | jump p95 | capture warm / cold | memory PSS |
| --- | --- | --- | --- | --- | --- | --- |
| tauri-default | crashed at launch | | | | | |
| tauri-nodmabuf | 85 | 69 | 6.0ms | 96ms | 10 / 154ms | 419 MB |
| tauri-nocompositing | 85 | 69 | 6.2ms | 96ms | 19 / 158ms | 432 MB |
| tauri-x11 | hung, never rendered | | | | | |
| electron-wayland | 229 | 236 | 3.3ms | 38ms | 15 / 93ms | 582 MB |
| electron-x11 | 232 | 236 | 3.0ms | 35ms | 8 / 84ms | 521 MB |

**Stock Tauri doesn't run on this machine.** `tauri-default` dies immediately with `Error 71 (Protocol error) dispatching to Wayland display`, which is the NVIDIA DMA-BUF failure in Tauri's own Linux troubleshooting docs. Both workarounds start, but WebKitGTK then tops out around 70–85 fps under load on a 240 Hz panel. `tauri-x11` failed to allocate GBM buffers and never drew a frame.

**Electron holds the display's refresh rate** while typing and scrolling through the 100k-word document, and its JavaScript engine does about half the work per keystroke (3.3 vs 6.0ms at p95). Jumping to a random spot in the document costs 38ms against 96ms.

**Tauri's advantages are smaller than expected.** It uses roughly 150 MB less memory and reaches its first frame sooner after the page starts (110 vs 223ms), but launch-to-first-frame is a wash at about 400ms for both. Capture windows that already exist appear in 10–20ms in either shell. Brand-new windows take 155ms in Tauri, because WebKit spawns a new web process, and about 90ms in Electron.

Two caveats on the raw files. Electron's `gpuFeatures` field says `disabled_software` because it's read before the GPU process finishes starting; a separate probe shows GPU compositing enabled on the NVIDIA card. And the `refreshMs` field is the idle frame interval, which both engines throttle, so ignore it.

**Verdict:** use Electron for the desktop shell unless the manual feel test contradicts these numbers. Revisit when WebKitGTK 2.54 (Skia compositor by default) reaches Arch or Tauri's CEF backend ships. `bridge.ts` keeps the editor independent of the shell, so switching later costs little.

## Things already learned

- **Run it from a normal terminal.** The Claude Code shell sandbox blocks GPU driver access (`/usr/lib/gbm/dri_gbm.so: Permission denied`), so anything launched from it renders in software.
- **With no displays connected, native-Wayland Electron hangs before `ready`,** and so does Chrome. Tauri/GTK starts fine in the same state. Electron and Obsidian work when launched with the monitor on, so this matters mainly for autostart before the display is up or while it's asleep.
- **The KWin keep-above script works** (`scripts/kwin-keep-above.sh`): it matched and pinned the Electron window by pid and caption.
- **Table typing isn't the bottleneck.** A keystroke costs p95 ≈1.4ms inside the 300-row table and ≈0.6ms in a paragraph (dispatch and DOM update, measured in Chromium).
