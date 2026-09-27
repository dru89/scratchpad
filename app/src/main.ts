// Entry point for every window. The window's kind (main, capture, or draft)
// decides which pieces it gets; see docs/design.md#windows.

import './style.css';
import { bridge, type DraftState } from './bridge';
import { DraftController } from './controller';
import { type CopyWhat, copyDraft, duplicateDraft } from './draftops';
import { escapeHtml } from './format';
import { type IconName, icon } from './icons';
import { InfoPanel } from './info';
import { Rpc } from './rpc';
import { installSidebarResize } from './resize';
import { Sidebar } from './sidebar';
import { Switcher } from './switcher';
import { installTooltips } from './tooltip';
import { type Actions, Toolbar } from './toolbar';

// Set up the connection first, so no status event is missed.
const rpc = new Rpc();
const status = { floating: false, connected: false };
let toolbar: Toolbar | null = null;
rpc.onConnect(() => {
  status.connected = true;
  toolbar?.render();
  void rpc.call('drafts.subscribe').catch(() => {});
});
rpc.onDisconnect(() => {
  status.connected = false;
  toolbar?.render();
});

const isMac = navigator.platform.startsWith('Mac');

/** "Mod-Shift-p" style names, matching CodeMirror's keymap notation. */
function keyName(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (e.code === 'Backslash') key = '\\';
  parts.push(key);
  return parts.join('-');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string, iconName: IconName | null = 'done') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `${iconName ? icon(iconName) : ''}<span>${escapeHtml(message)}</span>`;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

async function start() {
  installTooltips();
  const info = await bridge().info();
  const kind = info.kind;
  document.body.classList.add(`kind-${kind}`);
  if (kind === 'main' && info.prefs.sidebar === false) document.body.classList.add('no-sidebar');
  status.floating = !!info.prefs.float;

  const app = document.getElementById('app')!;
  // The capture window's toolbar sits under the editor, so its text starts
  // right under the title bar (docs/visual-design.md#layout).
  const editorEl = '<div id="editor" class="editor"></div>';
  app.innerHTML = `
    ${kind === 'main' ? '<aside id="sidebar" class="sidebar"></aside>' : ''}
    <main id="pane" class="pane">${
      kind === 'capture' ? `${editorEl}<footer id="toolbar" class="toolbar"></footer>` : `<header id="toolbar" class="toolbar"></header>${editorEl}`
    }</main>`;

  const controller = new DraftController(document.getElementById('editor')!, rpc, kind, info.prefs, info.idleMs);
  const switcher = new Switcher(rpc, controller);
  const infoPanel = new InfoPanel(rpc, (m) => toast(m), () => controller.focus());
  const showInfo = (id: string) => void infoPanel.show(id).catch(() => toast("Couldn't get info: scratchpadd isn't reachable", null));
  const sidebar =
    kind === 'main'
      ? new Sidebar(document.getElementById('sidebar')!, rpc, controller, { toast: (m) => toast(m), info: showInfo })
      : null;
  if (kind === 'main') {
    installSidebarResize(document.getElementById('sidebar')!, info.prefs.sidebarWidth, (sidebarWidth) => void bridge().savePrefs({ sidebarWidth }));
  }

  const setState = async (state: DraftState, message: string, iconName: IconName) => {
    await controller.setState(state);
    toast(message, iconName);
    // The main and capture windows move on; a draft's own window stays on it.
    if (kind !== 'draft' && state !== 'inbox') controller.newDraft();
  };

  const actions: Actions = {
    toggleSidebar() {
      if (kind !== 'main') return;
      const hidden = document.body.classList.toggle('no-sidebar');
      void bridge().savePrefs({ sidebar: !hidden });
    },
    newDraft: () => kind !== 'draft' && controller.newDraft(),
    done() {
      if (kind === 'draft') return;
      controller.newDraft();
      if (kind === 'capture') bridge().hide();
    },
    pin() {
      if (kind === 'draft') return;
      controller.setPinned(!controller.pinned);
      toast(controller.pinned ? 'Pinned: this draft stays when you come back' : 'Unpinned', 'pin');
    },
    async float() {
      status.floating = await bridge().setFloat(!status.floating);
      toolbar?.render();
    },
    async copyRich() {
      if (controller.isBlank()) return;
      try {
        await bridge().copyRich(controller.markdownForCopy());
        toast('Copied as rich text');
      } catch {
        toast("Couldn't copy: scratchpadd isn't reachable", null);
      }
    },
    async archive() {
      if (!controller.draftId) return;
      if (controller.state === 'archived') await setState('inbox', 'Moved to Inbox', 'inbox');
      else await setState('archived', 'Archived', 'archive');
    },
    async trash() {
      if (!controller.draftId) return;
      if (controller.state === 'trashed') await setState('inbox', 'Restored', 'inbox');
      else await setState('trashed', 'Moved to Trash', 'trash');
    },
    openWindow() {
      const id = controller.draftId;
      if (id) void bridge().openDraft(id);
    },
  };

  toolbar = new Toolbar(document.getElementById('toolbar')!, controller, actions, status);

  // The Draft menu's actions beyond the toolbar's, on this window's draft.
  const copyOwn = async (what: CopyWhat) => {
    const id = controller.draftId;
    if (!id || controller.isBlank()) return;
    try {
      toast(await copyDraft(rpc, id, what, { text: controller.text, title: controller.title }));
    } catch {
      toast("Couldn't copy: scratchpadd isn't reachable", null);
    }
  };
  const duplicate = async () => {
    if (!controller.draftId || controller.isBlank()) return;
    const copy = await duplicateDraft(rpc, controller.text);
    // A draft's own window stays on its draft, so the copy gets a window too.
    if (kind === 'draft') await bridge().openDraft(copy);
    else await controller.load(copy);
    toast('Duplicated');
  };
  const getInfo = () => {
    if (controller.draftId) showInfo(controller.draftId);
  };

  const params = new URLSearchParams(location.search);
  const ready = controller.init(kind === 'draft' ? (params.get('draft') ?? undefined) : info.prefs.draftId);

  if (kind === 'draft') {
    controller.onRemoved = () => bridge().close();
    controller.onChange(() => bridge().setTitle(`${controller.title} — scratchpad`));
    void ready.then(() => {
      if (!controller.draftId) {
        toast("This draft doesn't exist anymore", null);
        setTimeout(() => bridge().close(), 1500);
      }
    });
  }

  // Summoned by the hotkey (`scratchpad capture`), or asked to load a draft.
  bridge().onSummon(async (p) => {
    await ready;
    if (p.mode === 'new') controller.newDraft();
    else if (p.mode === 'load' && p.draftId) await controller.load(p.draftId);
    else controller.applyIdleRule();
    controller.focus();
  });

  // Coming back to the main or capture window applies the idle rule.
  window.addEventListener('focus', () => {
    if (kind !== 'draft' && !switcher.isOpen) void ready.then(() => controller.applyIdleRule());
  });

  const shortcuts: Record<string, () => unknown> = {
    'Mod-n': actions.newDraft,
    'Mod-Enter': actions.done,
    'Mod-k': () => switcher.open(),
    'Mod-Shift-p': actions.pin,
    'Mod-Shift-f': actions.float,
    'Mod-Shift-c': actions.copyRich,
    'Mod-Shift-a': actions.archive,
    'Mod-Shift-Backspace': actions.trash,
    'Mod-Shift-o': actions.openWindow,
    'Mod-i': getInfo,
    'Mod-\\': actions.toggleSidebar,
    'Mod-1': () => sidebar?.setTab('inbox'),
    'Mod-2': () => sidebar?.setTab('archived'),
    'Mod-3': () => sidebar?.setTab('trashed'),
    'Mod-Shift-l': () => sidebar?.focusFilter(),
  };
  // Capture phase, so app shortcuts win over the editor's own (Mod-Enter
  // would otherwise insert a blank line).
  window.addEventListener(
    'keydown',
    (e) => {
      const name = keyName(e);
      const run = shortcuts[name];
      if (!run || infoPanel.isOpen || (switcher.isOpen && name !== 'Mod-k')) return;
      e.preventDefault();
      e.stopPropagation();
      void run();
    },
    true,
  );
  // From the Draft menu. On Linux the keys arrive above as well; on macOS the
  // menu takes them and sends them here.
  const menuActions: Record<string, () => unknown> = {
    newDraft: actions.newDraft,
    pin: actions.pin,
    float: actions.float,
    copyRich: actions.copyRich,
    copyContents: () => copyOwn('contents'),
    copyTitle: () => copyOwn('title'),
    copyLink: () => copyOwn('link'),
    copyId: () => copyOwn('id'),
    duplicate,
    info: getInfo,
    openWindow: actions.openWindow,
    archive: actions.archive,
    trash: actions.trash,
  };
  bridge().onMenuAction((action) => {
    if (!switcher.isOpen && !infoPanel.isOpen) void menuActions[action]?.();
  });

  // Bubble phase, so the search panel and switcher get Escape first.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || kind !== 'capture' || switcher.isOpen || infoPanel.isOpen) return;
    if (controller.isBlank()) controller.newDraft();
    bridge().hide();
  });

  // Flush the pending modifiedAt stamp, and discard an empty draft.
  window.addEventListener('beforeunload', () => controller.dispose());

  await ready;
  controller.focus();
}

void start();
