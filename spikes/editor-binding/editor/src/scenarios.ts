// Automated checks for the binding. Each scenario drives the editor the way
// typing would (one transaction per keystroke) while the daemon plays the
// agent, then checks the window against the daemon's copy.

import { type Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Binding } from './binding';
import type { Rpc } from './rpc';
import type { DocSession } from './session';

export interface Ctx {
  view: EditorView;
  session: DocSession;
  rpc: Rpc;
  binding: Binding;
  bindingSlot: Compartment;
  log: (s: string) => void;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await nextFrame();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wallNow = () => performance.timeOrigin + performance.now();
const round = (x: number) => Math.round(x * 100) / 100;

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1] ?? 0) };
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await nextFrame();
  }
}

/** Waits until no update has arrived from the daemon for `ms`. */
async function quiet(ctx: Ctx, ms = 400) {
  await sleep(ms);
  while (performance.now() - ctx.session.stats.lastRemoteAt < ms) await sleep(50);
}

function typeChar(view: EditorView, ch: string) {
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + ch.length }, userEvent: 'input.type' });
}

async function typeString(view: EditorView, s: string) {
  for (const ch of s) {
    typeChar(view, ch);
    await nextFrame();
  }
}

async function daemonText(ctx: Ctx): Promise<string> {
  return (await ctx.rpc.call<{ text: string }>('drafts.get', { id: ctx.session.id })).text;
}

async function converged(ctx: Ctx) {
  const d = await daemonText(ctx);
  const w = ctx.view.state.doc.toString();
  return { converged: d === w, daemonChars: d.length, windowChars: w.length };
}

/** Puts the cursor inside a paragraph near the middle of the document. */
function placeInParagraph(view: EditorView, fraction = 0.5, at: 'middle' | 'end' = 'middle') {
  const text = view.state.doc.toString();
  let p = text.indexOf('\n\n', Math.floor(text.length * fraction)) + 2;
  while (!/[A-Z]/.test(text[p])) p = text.indexOf('\n\n', p) + 2;
  const line = view.state.doc.lineAt(p);
  const head = at === 'end' ? line.to : line.from + Math.min(40, Math.floor(line.length / 2));
  view.dispatch({ selection: { anchor: head }, scrollIntoView: true });
  view.focus();
  return head;
}

async function cursorStability(ctx: Ctx) {
  const { view, rpc, session } = ctx;
  const head = placeInParagraph(view, 0.5);
  await frames(5);
  const before = view.state.sliceDoc(head - 30, head);
  const after = view.state.sliceDoc(head, head + 30);

  const marker = 'AGENT PARAGRAPH INSERTED AT TOP';
  let t0 = performance.now();
  await rpc.call('drafts.insert', { id: session.id, pos: 0, text: `${marker}\n\n` });
  await waitFor(() => view.state.doc.sliceString(0, marker.length) === marker, 'agent insert');
  const insertLatencyMs = performance.now() - t0;

  // The agent rewrites words above and below the cursor via setText.
  const cur = view.state.doc.toString();
  const h = view.state.selection.main.head;
  const above = cur.lastIndexOf(' the ', h - 300);
  const below = cur.indexOf(' the ', h + 300);
  const next = cur.slice(0, above) + ' THE-AGENT-ABOVE ' + cur.slice(above + 5, below) + ' THE-AGENT-BELOW ' + cur.slice(below + 5);
  t0 = performance.now();
  const res = await rpc.call<{ editMs: number; updateBytes: number }>('drafts.setText', { id: session.id, text: next });
  await waitFor(() => view.state.doc.length === next.length && view.state.doc.toString() === next, 'agent setText');
  const setTextLatencyMs = performance.now() - t0;

  const headAfter = view.state.selection.main.head;
  return {
    contextPreserved:
      view.state.sliceDoc(headAfter - 30, headAfter) === before && view.state.sliceDoc(headAfter, headAfter + 30) === after,
    headMovedBy: headAfter - head,
    expectedMove: marker.length + 2 + ' THE-AGENT-ABOVE '.length - 5,
    insertLatencyMs: round(insertLatencyMs),
    setTextLatencyMs: round(setTextLatencyMs),
    daemonSetTextEditMs: round(res.editMs),
    setTextUpdateBytes: res.updateBytes,
    ...(await converged(ctx)),
  };
}

async function undoIsolation(ctx: Ctx) {
  const { view, rpc, session, binding } = ctx;
  const start = placeInParagraph(view, 0.4, 'end');
  await sleep(1000); // let any earlier undo group close
  const beforeTyping = view.state.doc.toString();
  const typed = ' HELLO-UNDO-TEST';
  await typeString(view, typed);
  await sleep(50);
  const tail = '\n\nAGENT APPENDED AT END';
  await rpc.call('drafts.append', { id: session.id, text: tail });
  await waitFor(() => view.state.doc.toString().endsWith(tail), 'agent append');

  view.dispatch({ selection: { anchor: 10 } }); // move away so restore is visible
  binding.undo(view);
  await frames(3);
  const afterUndo = view.state.doc.toString();
  const undoResult = {
    exactlyTypingRemoved: afterUndo === beforeTyping + tail,
    typedRemoved: !afterUndo.includes(typed),
    agentTextKept: afterUndo.endsWith(tail),
    cursorRestoredToStart: view.state.selection.main.head === start,
    cursorAt: view.state.selection.main.head,
    expectedCursor: start,
  };

  binding.redo(view);
  await frames(3);
  const afterRedo = view.state.doc.toString();
  const redoResult = {
    typedBack: afterRedo.includes(typed),
    agentTextKept: afterRedo.endsWith(tail),
    cursorAtEndOfRedo: view.state.selection.main.head === start + typed.length,
  };
  await quiet(ctx);
  return { undo: undoResult, redo: redoResult, ...(await converged(ctx)) };
}

/** What undo does when an agent has edited text you typed. Informational. */
async function undoAfterAgentEditedYourText(ctx: Ctx) {
  const { view, rpc, session, binding } = ctx;
  placeInParagraph(view, 0.45, 'end');
  await frames(3);
  const typed = ' ZEBRA QUAGGA';
  await typeString(view, typed);
  await sleep(900); // past the undo merge interval, so typing is one group
  const cur = view.state.doc.toString();
  const next = cur.replace('ZEBRA QUAGGA', 'ZEBRA OKAPI');
  await rpc.call('drafts.setText', { id: session.id, text: next });
  await waitFor(() => view.state.doc.toString().includes('ZEBRA OKAPI'), 'agent rewrite of typed text');
  binding.undo(view);
  await frames(3);
  const text = view.state.doc.toString();
  const i = text.indexOf('OKAPI');
  return {
    leftover: i >= 0 ? JSON.stringify(text.slice(Math.max(0, i - 12), i + 10)) : '(agent word gone too)',
    typedGone: !text.includes('ZEBRA'),
    ...(await converged(ctx)),
  };
}

async function typingDuringAgentStorm(ctx: Ctx) {
  const { view, rpc, session } = ctx;
  const near = placeInParagraph(view, 0.55);
  await frames(3);
  // Digits and spaces, so the agent (which rewrites letter words) can't touch them.
  const typed = '1234567890 '.repeat(11);
  const done = new Promise<{ editMs: number[] }>((resolve) => {
    const off = rpc.on('spike.stormDone', (p) => {
      off();
      resolve(p);
    });
  });
  await rpc.call('spike.agentStorm', { id: session.id, near, count: 30, intervalMs: 25 });
  const remoteBefore = session.stats.remoteUpdates;
  await typeString(view, typed);
  const storm = await done;
  await quiet(ctx, 500);
  const final = view.state.doc.toString();
  return {
    typedContiguous: final.includes(typed),
    agentEditsReceived: session.stats.remoteUpdates - remoteBefore,
    daemonEditMs: stats(storm.editMs),
    ...(await converged(ctx)),
  };
}

async function daemonRestart(ctx: Ctx) {
  const { view, rpc, session } = ctx;
  placeInParagraph(view, 0.6);
  await frames(3);
  rpc.call('spike.shutdown').catch(() => {});
  await waitFor(() => !rpc.connected, 'disconnect');
  const tDown = performance.now();
  const typed = ' typed-while-daemon-was-down';
  await typeString(view, typed);
  await waitFor(() => rpc.connected && session.opened, 'reconnect', 15000);
  const reconnectMs = performance.now() - tDown;
  await quiet(ctx);
  const d = await daemonText(ctx);
  return { reconnectMs: round(reconnectMs), typedReachedDaemon: d.includes(typed), ...(await converged(ctx)) };
}

function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

async function secondWindow(ctx: Ctx) {
  const { view, session } = ctx;
  const inbox: any[] = [];
  window.spike.onMessage((m) => inbox.push(m));
  await window.spike.openWindow({ role: 'observer', doc: session.id });
  await waitFor(() => inbox.some((m) => m.type === 'ready'), 'observer ready', 15000);

  placeInParagraph(view, 0.3, 'end');
  const sent = new Map<string, number>();
  for (let i = 0; i < 20; i++) {
    const marker = ` [m${i}-${Math.random().toString(36).slice(2, 7)}]`;
    sent.set(marker.trim(), wallNow());
    typeChar(view, marker);
    await sleep(100);
  }
  await waitFor(() => inbox.filter((m) => m.type === 'seen').length >= 20, 'observer to see markers');
  const latencies = inbox.filter((m) => m.type === 'seen').map((m) => m.t - (sent.get(m.marker) ?? m.t));

  await quiet(ctx);
  window.spike.broadcast({ type: 'hashRequest' });
  await waitFor(() => inbox.some((m) => m.type === 'hash'), 'observer hash');
  const theirs = inbox.find((m) => m.type === 'hash');
  window.spike.broadcast({ type: 'close' });
  return {
    windowToWindowMs: stats(latencies),
    observerMatches: theirs.hash === hash(view.state.doc.toString()),
    ...(await converged(ctx)),
  };
}

async function typingBench(view: EditorView, n = 200) {
  placeInParagraph(view, 0.5);
  await frames(10);
  const pos = view.state.selection.main.head;
  const dispatchMs: number[] = [];
  const frameMs: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    view.dispatch({ changes: { from: pos + i, insert: 'x' }, selection: { anchor: pos + i + 1 }, userEvent: 'input.type' });
    dispatchMs.push(performance.now() - t0);
    const ts = await nextFrame();
    frameMs.push(ts - last);
    last = ts;
  }
  view.dispatch({ changes: { from: pos, to: pos + n } });
  await frames(5);
  return { dispatchMs: stats(dispatchMs), frameMs: stats(frameMs) };
}

async function bindingOverhead(ctx: Ctx) {
  const { view, bindingSlot, binding } = ctx;
  view.dispatch({ effects: bindingSlot.reconfigure([]) });
  const without = await typingBench(view);
  view.dispatch({ effects: bindingSlot.reconfigure(binding.extension) });
  await frames(5);
  const withBinding = await typingBench(view);
  await quiet(ctx);
  return { withoutBinding: without, withBinding, ...(await converged(ctx)) };
}

export async function runScenarios(ctx: Ctx) {
  const out: Record<string, unknown> = {};
  const only = new URLSearchParams(location.search).get('only')?.split(',');
  const run = async (name: string, fn: (c: Ctx) => Promise<unknown>) => {
    if (only && !only.includes(name)) return;
    ctx.log(name);
    try {
      out[name] = await fn(ctx);
    } catch (e) {
      out[name] = { error: String(e) };
    }
    await sleep(300);
  };
  await run('bindingOverhead', bindingOverhead);
  await run('cursorStability', cursorStability);
  await run('undoIsolation', undoIsolation);
  await run('undoAfterAgentEditedYourText', undoAfterAgentEditedYourText);
  await run('typingDuringAgentStorm', typingDuringAgentStorm);
  await run('secondWindow', secondWindow);
  await run('daemonRestart', daemonRestart);
  out.sessionStats = { ...ctx.session.stats };
  out.daemonStats = await ctx.rpc.call('spike.stats', { id: ctx.session.id }).catch((e) => String(e));
  return out;
}

export { hash };
