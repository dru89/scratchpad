// Overlay for the manual feel test: live key-to-frame latency and frame
// pacing, plus buttons for the plumbing checks (rich copy, float, capture).

import type { EditorView } from '@codemirror/view';
import { marked } from 'marked';
import { stats } from './bench';
import type { Bridge, ShellInfo } from './bridge';

export interface Hud {
  setStatus(s: string): void;
  pauseLive(paused: boolean): void;
}

export function mountHud(el: HTMLElement, view: EditorView, bridge: Bridge, info: ShellInfo, onRunBench: () => void): Hud {
  el.innerHTML = `
    <div class="hud-title">${info.shell} · ${info.variant}</div>
    <div class="hud-metrics">
      <div>key→frame <span data-k="key">–</span></div>
      <div>frames (2s) <span data-k="frames">–</span></div>
      <div>doc <span data-k="doc">–</span></div>
    </div>
    <div class="hud-buttons">
      <button data-a="bench">Run benchmarks</button>
      <button data-a="copy-native">Copy rich (native)</button>
      <button data-a="copy-dom">Copy rich (DOM)</button>
      <button data-a="float">Float: off</button>
      <button data-a="warm">Capture (warm)</button>
      <button data-a="cold">Capture (cold)</button>
      <button data-a="hide">Hide HUD (F2)</button>
    </div>
    <div class="hud-status" data-k="status"></div>`;
  const $ = (k: string) => el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;

  const keyLat: number[] = [];
  const frameTs: number[] = [];
  let paused = false;
  let floating = false;

  // keydown timestamp to the first task after the next frame's rendering steps.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'F2') {
        el.hidden = !el.hidden;
        return;
      }
      const t0 = e.timeStamp;
      requestAnimationFrame(() =>
        setTimeout(() => {
          keyLat.push(performance.now() - t0);
          if (keyLat.length > 200) keyLat.shift();
        }, 0),
      );
    },
    true,
  );

  const loop = (ts: number) => {
    if (!paused) {
      frameTs.push(ts);
      while (frameTs.length && ts - frameTs[0] > 2000) frameTs.shift();
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  setInterval(() => {
    if (paused) return;
    if (keyLat.length) {
      const s = stats(keyLat);
      $('key').textContent = `p50 ${s.p50.toFixed(1)} · p95 ${s.p95.toFixed(1)} · max ${s.max.toFixed(0)}ms (n=${s.n})`;
    }
    if (frameTs.length > 2) {
      const iv = frameTs.slice(1).map((t, i) => t - frameTs[i]);
      const s = stats(iv);
      $('frames').textContent = `${(1000 / s.mean).toFixed(0)} fps · worst ${s.max.toFixed(1)}ms`;
    }
    $('doc').textContent = `${(view.state.doc.length / 1024).toFixed(0)} KB · ${view.state.doc.lines} lines`;
  }, 250);

  const setStatus = (s: string) => {
    $('status').textContent = s;
  };

  const markdownForCopy = () => {
    const sel = view.state.selection.main;
    return sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  };

  el.addEventListener('click', async (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    try {
      switch (action) {
        case 'bench':
          onRunBench();
          break;
        case 'copy-native': {
          const md = markdownForCopy();
          const t0 = performance.now();
          const html = await marked.parse(md);
          await bridge.copyRich(html, md);
          setStatus(`native: copied ${(html.length / 1024).toFixed(0)} KB html in ${(performance.now() - t0).toFixed(0)}ms`);
          break;
        }
        case 'copy-dom': {
          const md = markdownForCopy();
          const html = await marked.parse(md);
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([md], { type: 'text/plain' }),
            }),
          ]);
          setStatus(`DOM: copied ${(html.length / 1024).toFixed(0)} KB html`);
          break;
        }
        case 'float': {
          floating = !floating;
          const out = await bridge.keepAbove(floating);
          (e.target as HTMLElement).textContent = `Float: ${floating ? 'on' : 'off'}`;
          setStatus(`keepAbove=${floating}: ${out}`);
          break;
        }
        case 'warm':
        case 'cold':
          await bridge.openCapture(action, false);
          setTimeout(async () => {
            const t = (await bridge.captureTimings()).at(-1);
            if (t) setStatus(`capture ${t.mode}: ${t.ms.toFixed(1)}ms to first frame`);
          }, 1500);
          break;
        case 'hide':
          el.hidden = true;
          break;
      }
    } catch (err) {
      setStatus(`${action} failed: ${err}`);
    }
  });

  return {
    setStatus,
    pauseLive(p) {
      paused = p;
    },
  };
}
