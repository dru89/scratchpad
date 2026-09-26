performance.mark('script-start');

import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createBinding, remote } from './binding';
import { createEditor } from './editor';
import { Rpc } from './rpc';
import { hash, runScenarios } from './scenarios';
import { DocSession } from './session';

const params = new URLSearchParams(location.search);
const role = params.get('role') ?? 'main';
const docId = params.get('doc') ?? 'large';
const fixture = params.get('fixture');
const autorun = params.get('autorun') === '1';
(window as any).spikeDebug = params.has('only');

const app = document.getElementById('app')!;
const hudEl = document.getElementById('hud')!;
const round = (x: number) => Math.round(x * 100) / 100;
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const wallNow = () => performance.timeOrigin + performance.now();

const rpc = new Rpc();
const session = new DocSession(docId, rpc);
const load: Record<string, unknown> = {
  navToScriptMs: round(performance.getEntriesByName('script-start')[0].startTime),
};
let view: EditorView | null = null;
let status = '';

rpc.onConnect(async () => {
  try {
    if (!view) {
      load.connectedMs = round(performance.now());
      if (role === 'main' && fixture) {
        const t0 = performance.now();
        await rpc.call('spike.create', { id: docId, path: fixture });
        load.createDraftMs = round(performance.now() - t0);
      }
      const opened = await session.open();
      Object.assign(load, { openRpcMs: round(opened.rpcMs), importMs: round(opened.importMs), snapshotBytes: opened.bytes });
      mount();
    } else {
      await session.open();
    }
  } catch (e) {
    status = `open failed: ${e}`;
  }
});

function mount() {
  const binding = createBinding(session);
  const bindingSlot = new Compartment();
  const t0 = performance.now();
  const extras = [bindingSlot.of(binding.extension)];
  if (role === 'observer') extras.push(observerListener());
  view = createEditor(app, session.body.toString(), extras);
  load.createViewMs = round(performance.now() - t0);
  const v = view;
  void nextFrame().then(nextFrame).then(() => {
    load.navToFirstFrameMs = round(performance.now());
    if (role === 'observer') {
      document.title = 'observer';
      window.spike.broadcast({ type: 'ready' });
      window.spike.onMessage((m) => {
        if (m.type === 'hashRequest') window.spike.broadcast({ type: 'hash', hash: hash(v.state.doc.toString()) });
        if (m.type === 'close') window.close();
      });
      return;
    }
    mountHud(v, binding, bindingSlot);
    if (autorun) void autorunAll(v, binding, bindingSlot);
  });
}

/** In the observer window, report when each marker typed in the main window shows up. */
function observerListener() {
  return EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      if (!tr.annotation(remote)) continue;
      tr.changes.iterChanges((_a, _b, _c, _d, inserted) => {
        for (const m of inserted.toString().matchAll(/\[m\d+-[a-z0-9]+\]/g)) {
          requestAnimationFrame(() => window.spike.broadcast({ type: 'seen', marker: m[0], t: wallNow() }));
        }
      });
    }
  });
}

type Binding = ReturnType<typeof createBinding>;

async function runAndSave(v: EditorView, binding: Binding, bindingSlot: Compartment) {
  const results = await runScenarios({
    view: v,
    session,
    rpc,
    binding,
    bindingSlot,
    log: (s) => {
      status = `running: ${s}`;
      console.log(`scenario: ${s}`);
    },
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = await window.spike.save(`${stamp}_binding`, { load, userAgent: navigator.userAgent, results });
  status = `saved ${file}`;
  console.log(`saved ${file}`);
}

async function autorunAll(v: EditorView, binding: Binding, bindingSlot: Compartment) {
  await new Promise((r) => setTimeout(r, 1500));
  await runAndSave(v, binding, bindingSlot);
  await window.spike.quit();
}

function mountHud(v: EditorView, binding: Binding, bindingSlot: Compartment) {
  hudEl.innerHTML = `
    <div class="hud-title">binding spike · ${docId}</div>
    <div class="hud-metrics" data-k="metrics"></div>
    <div class="hud-buttons">
      <button data-a="insert">Agent: insert at top</button>
      <button data-a="storm">Agent: storm near cursor</button>
      <button data-a="observer">Open second window</button>
      <button data-a="restart">Restart daemon</button>
      <button data-a="run">Run scenarios</button>
    </div>
    <div class="hud-status" data-k="status"></div>`;
  const $ = (k: string) => hudEl.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  setInterval(() => {
    const s = session.stats;
    $('metrics').innerHTML = [
      `daemon: ${rpc.connected ? (session.opened ? 'synced' : 'connecting') : 'disconnected'}`,
      `peer ${session.doc.peerIdStr.slice(-6)} · ${v.state.doc.length} chars`,
      `sent ${s.pushes} (${(s.pushBytes / 1024).toFixed(1)} KB) · received ${s.remoteUpdates}`,
      `modifiedAt stamps ${s.stamps} · undo ${binding.undoManager.canUndo() ? 'yes' : 'no'}`,
    ].join('<br>');
    $('status').textContent = status;
  }, 250);

  hudEl.addEventListener('click', async (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    try {
      if (action === 'insert') await rpc.call('drafts.insert', { id: docId, pos: 0, text: `Agent note at ${new Date().toLocaleTimeString()}\n\n` });
      if (action === 'storm') await rpc.call('spike.agentStorm', { id: docId, near: v.state.selection.main.head, count: 20, intervalMs: 150 });
      if (action === 'observer') await window.spike.openWindow({ role: 'observer', doc: docId });
      if (action === 'restart') await rpc.call('spike.shutdown').catch(() => {});
      if (action === 'run') await runAndSave(v, binding, bindingSlot);
    } catch (err) {
      status = `${action} failed: ${err}`;
    }
  });
}
