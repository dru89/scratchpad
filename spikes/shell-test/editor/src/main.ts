performance.mark('script-start');

import * as bench from './bench';
import { frames, runAll } from './bench';
import { createBridge, wallNow } from './bridge';
import { createEditor } from './editor';
import { mountHud } from './hud';

const bridge = createBridge();
const app = document.getElementById('app')!;
const hudEl = document.getElementById('hud')!;
const round = (x: number) => Math.round(x * 100) / 100;

async function mountMain() {
  const info = await bridge.info();
  const scriptStart = performance.getEntriesByName('script-start')[0].startTime;

  const t0 = performance.now();
  const text = await bridge.loadFixture('large.md');
  const t1 = performance.now();
  const view = createEditor(app, text);
  const t2 = performance.now();
  await frames(2);
  const t3 = performance.now();

  const load = {
    navToScriptMs: round(scriptStart),
    fixtureIpcMs: round(t1 - t0),
    fixtureChars: text.length,
    createViewMs: round(t2 - t1),
    firstFrameMs: round(t3 - t2),
    navToFirstFrameMs: round(t3),
    launchToFirstFrameMs: info.launchMs ? round(wallNow() - info.launchMs) : null,
  };

  let running = false;
  const runBench = async () => {
    if (running) return;
    running = true;
    hud.pauseLive(true);
    const log = (s: string) => {
      console.log(`bench: ${s}`);
      hud.setStatus(`bench: ${s}`);
    };
    // A covered Wayland window gets no frame callbacks, which stalls rAF.
    log(`keepAbove: ${await bridge.keepAbove(true).catch((e) => `failed: ${e}`)}`);
    const result = await runAll(view, bridge, info, load, log);
    await bridge.keepAbove(false).catch(() => {});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = await bridge.saveResult(`${stamp}_${info.variant}`, result);
    hud.setStatus(`saved ${path}`);
    hud.pauseLive(false);
    running = false;
    return path;
  };

  // Handles for poking at things from devtools.
  Object.assign(window, { spike: { view, bench, bridge } });

  const hud = mountHud(hudEl, view, bridge, info, () => void runBench());
  hud.setStatus(`loaded in ${load.navToFirstFrameMs}ms (ipc ${load.fixtureIpcMs}ms)`);

  if (info.autorun) {
    await runBench();
    await bridge.quit();
  }
}

async function mountCapture() {
  document.body.classList.add('capture');
  hudEl.hidden = true;
  const view = createEditor(app, '', { placeholder: 'Dump a thought…' });
  view.focus();
  if (bridge.label === 'capture-warm') {
    bridge.onCaptureShown(async () => {
      await frames(2);
      await bridge.reportFrame(wallNow());
      view.focus();
    });
  } else {
    await frames(2);
    await bridge.reportFrame(wallNow());
  }
}

(bridge.label.startsWith('capture') ? mountCapture() : mountMain()).catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(err?.stack ?? err)}</pre>`);
});
