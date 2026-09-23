// Automated measurements. Everything here runs in-page, so it measures main
// thread work and frame pacing as the engine reports them. It cannot see
// compositor or display latency; the manual feel test covers that.

import type { EditorView } from '@codemirror/view';
import { type Bridge, type CaptureTiming, type ShellInfo } from './bridge';

export const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
export const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await nextFrame();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (x: number) => Math.round(x * 100) / 100;

export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames longer than 1.5x the display refresh interval. */
  dropped?: number;
}

export function stats(xs: number[], refresh?: number): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const out: Stats = {
    n: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    p99: round(q(0.99)),
    max: round(s[s.length - 1] ?? 0),
  };
  if (refresh) out.dropped = xs.filter((x) => x > refresh * 1.5).length;
  return out;
}

export async function measureRefresh(): Promise<number> {
  const xs: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < 120; i++) {
    const ts = await nextFrame();
    xs.push(ts - last);
    last = ts;
  }
  return stats(xs).p50;
}

const TYPED = 'The quick brown fox jumps over the lazy dog. ';

/** Types one character per frame at `pos`, then removes what it typed. */
export async function typingBench(view: EditorView, pos: number, n: number, refresh: number) {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
  await frames(10);
  const dispatchMs: number[] = [];
  const frameMs: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    view.dispatch({
      changes: { from: pos + i, insert: TYPED[i % TYPED.length] },
      selection: { anchor: pos + i + 1 },
      userEvent: 'input.type',
    });
    dispatchMs.push(performance.now() - t0);
    const ts = await nextFrame();
    frameMs.push(ts - last);
    last = ts;
  }
  view.dispatch({ changes: { from: pos, to: pos + n } });
  await frames(5);
  return { dispatch: stats(dispatchMs), frame: stats(frameMs, refresh) };
}

/** Scrolls continuously at a fixed speed and records frame intervals. */
export async function scrollSweep(view: EditorView, refresh: number, pxPerSec = 6000, seconds = 10) {
  const el = view.scrollDOM;
  el.scrollTop = 0;
  await frames(10);
  const xs: number[] = [];
  let pos = 0;
  let last = await nextFrame();
  const t0 = last;
  while (last - t0 < seconds * 1000) {
    const ts = await nextFrame();
    xs.push(ts - last);
    pos += (pxPerSec * (ts - last)) / 1000;
    el.scrollTop = pos;
    last = ts;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) break;
  }
  return { pxPerSec, distancePx: Math.round(pos), frame: stats(xs, refresh) };
}

/** Jumps to random offsets and times how long until two frames have rendered. */
export async function jumpBench(view: EditorView, jumps = 20) {
  const el = view.scrollDOM;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const xs: number[] = [];
  for (let i = 0; i < jumps; i++) {
    await frames(3);
    const t0 = performance.now();
    el.scrollTop = rand() * (el.scrollHeight - el.clientHeight);
    await frames(2);
    xs.push(performance.now() - t0);
  }
  return stats(xs);
}

/** Pastes ~100KB into the middle of the document, then removes it. */
export async function pasteBench(view: EditorView, pos: number) {
  const doc = view.state.doc;
  const mid = Math.floor(doc.length / 2);
  const chunk = doc.sliceString(mid, Math.min(doc.length, mid + 100_000));
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  await frames(5);
  const t0 = performance.now();
  view.dispatch({ changes: { from: pos, insert: chunk }, selection: { anchor: pos + chunk.length }, scrollIntoView: true });
  const dispatchMs = performance.now() - t0;
  await frames(2);
  const settledMs = performance.now() - t0;
  view.dispatch({ changes: { from: pos, to: pos + chunk.length } });
  await frames(5);
  return { chars: chunk.length, dispatchMs: round(dispatchMs), settledMs: round(settledMs) };
}

async function captureBench(bridge: Bridge, mode: 'warm' | 'cold', runs: number) {
  const out: CaptureTiming[] = [];
  for (let i = 0; i < runs; i++) {
    const before = (await bridge.captureTimings()).length;
    await bridge.openCapture(mode, true);
    const deadline = performance.now() + 5000;
    let timings = await bridge.captureTimings();
    while (timings.length === before && performance.now() < deadline) {
      await sleep(25);
      timings = await bridge.captureTimings();
    }
    if (timings.length > before) out.push(timings[timings.length - 1]);
    await sleep(900); // shell hides/closes the window 400ms after it reports
  }
  return {
    runs: out,
    ms: stats(out.map((t) => t.ms)),
    rttMs: stats(out.map((t) => t.rttMs)),
  };
}

function findPositions(view: EditorView) {
  const text = view.state.doc.toString();
  const mid = Math.floor(text.length / 2);
  const paraStart = text.indexOf('\n\n', mid) + 2;
  let p = paraStart;
  while (!/[A-Za-z]/.test(text[p])) p = text.indexOf('\n\n', p) + 2;
  const paraLine = view.state.doc.lineAt(p);
  const tableAt = text.indexOf('\n| ', mid) + 1;
  const headingAt = text.indexOf('\n## ', mid) + 1;
  return {
    paragraph: paraLine.from + Math.floor(paraLine.length / 2),
    table: tableAt + 3,
    heading: view.state.doc.lineAt(headingAt).to,
    start: text.indexOf('\n\n') + 2,
    end: text.length,
  };
}

export async function runAll(view: EditorView, bridge: Bridge, info: ShellInfo, load: unknown, log: (s: string) => void) {
  const result: Record<string, unknown> = {
    info,
    load,
    userAgent: navigator.userAgent,
    devicePixelRatio: devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
    docChars: view.state.doc.length,
    startedAt: new Date().toISOString(),
  };

  log('settling…');
  await sleep(1500);
  const refresh = await measureRefresh();
  result.refreshMs = refresh;
  log(`refresh ${refresh.toFixed(2)}ms`);

  const pos = findPositions(view);
  const typing: Record<string, unknown> = {};
  for (const [region, at] of Object.entries(pos)) {
    log(`typing: ${region}`);
    typing[region] = await typingBench(view, at, 200, refresh);
  }
  result.typing = typing;

  log('scroll sweep');
  result.scroll = await scrollSweep(view, refresh);
  log('jumps');
  result.jumps = await jumpBench(view);
  log('paste');
  result.paste = await pasteBench(view, pos.paragraph);

  log('capture warm');
  result.captureWarm = await captureBench(bridge, 'warm', 5);
  log('capture cold');
  result.captureCold = await captureBench(bridge, 'cold', 3);

  log('memory');
  await sleep(1000);
  result.memory = await bridge.memory();
  result.finishedAt = new Date().toISOString();
  return result;
}
