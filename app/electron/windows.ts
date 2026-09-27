// The three kinds of window from docs/design.md#windows: the main window
// (sidebar + editor), the capture window (created hidden at startup so the
// hotkey is instant), and windows opened for one draft. Window state is
// local to this device and lives in userData/state.json.

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonLink } from './daemon';
import { isKdeWayland, kwinApply } from './kwin';

export type Kind = 'main' | 'capture' | 'draft';

export interface WindowPrefs {
  draftId?: string;
  pinned?: boolean;
  loadedAt?: number;
  float?: boolean;
  sidebar?: boolean;
  width?: number;
  height?: number;
}

/** App-wide flags, kept under the "app" key. */
export interface AppPrefs {
  /** Open at Login was turned on at first launch; after that it's the user's to change. */
  loginItemSet?: boolean;
}

type Prefs = WindowPrefs & AppPrefs;

const DEFAULT_SIZE: Record<Kind, [number, number]> = { main: [1100, 780], capture: [560, 380], draft: [760, 720] };
const isMac = process.platform === 'darwin';

export class StateStore {
  private data: Record<string, Prefs> = {};
  private timer: NodeJS.Timeout | null = null;
  private file = join(app.getPath('userData'), 'state.json');

  constructor() {
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { capture: { float: true } };
    }
  }

  get(key: string): Prefs {
    return this.data[key] ?? (key === 'capture' ? { float: true } : {});
  }

  update(key: string, patch: Prefs) {
    this.data[key] = { ...this.get(key), ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  forget(key: string) {
    delete this.data[key];
    this.flush();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

interface Managed {
  win: BrowserWindow;
  kind: Kind;
  key: string;
  link: DaemonLink | null;
}

/** True when float and focus have to go through KWin. */
function useKwin() {
  return isKdeWayland && app.commandLine.getSwitchValue('ozone-platform') !== 'x11';
}

export class Windows {
  quitting = false;
  private byContents = new Map<number, Managed>();
  private main: Managed | null = null;
  private capture: Managed | null = null;
  private drafts = new Map<string, Managed>();

  constructor(private state: StateStore) {}

  managed(contentsId: number) {
    return this.byContents.get(contentsId);
  }

  prefs(m: Managed) {
    return this.state.get(m.key);
  }

  private create(kind: Kind, draftId?: string, show = true): Managed {
    const key = kind === 'draft' ? `draft:${draftId}` : kind;
    const prefs = this.state.get(key);
    const [dw, dh] = DEFAULT_SIZE[kind];
    const win = new BrowserWindow({
      width: prefs.width ?? dw,
      height: prefs.height ?? dh,
      minWidth: 320,
      minHeight: 200,
      show,
      title: kind === 'capture' ? 'Capture — scratchpad' : 'scratchpad',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        // The capture window renders while hidden so it's ready instantly.
        backgroundThrottling: kind !== 'capture',
      },
    });
    // On macOS the capture window can come up over a full-screen app, as a
    // panel does. Set once here: each call briefly hides the Dock icon.
    if (isMac && kind === 'capture') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const m: Managed = { win, kind, key, link: null };
    const contentsId = win.webContents.id;
    this.byContents.set(contentsId, m);
    win.on('page-title-updated', (e) => e.preventDefault());

    win.webContents.on('did-finish-load', () => {
      m.link?.close();
      m.link = new DaemonLink({
        onLine: (line) => !win.isDestroyed() && win.webContents.send('daemon:line', line),
        onStatus: (connected) => !win.isDestroyed() && win.webContents.send('daemon:status', { connected }),
      });
    });

    let resizeTimer: NodeJS.Timeout | null = null;
    win.on('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const [width, height] = win.getSize();
        this.state.update(key, { width, height });
      }, 400);
    });

    // The main and capture windows hide instead of closing, so the app
    // keeps running for the capture hotkey and reopens where you left off.
    if (kind !== 'draft') {
      win.on('close', (e) => {
        if (this.quitting) return;
        e.preventDefault();
        if (kind === 'capture') this.hide(m);
        else win.hide();
      });
    }
    win.on('show', () => {
      if (this.state.get(key).float) setTimeout(() => void this.applyFloat(m, true), 150);
    });
    win.on('closed', () => {
      m.link?.close();
      this.byContents.delete(contentsId);
      if (kind === 'draft' && draftId) this.drafts.delete(draftId);
    });

    const query = new URLSearchParams({ kind, ...(draftId ? { draft: draftId } : {}) });
    void win.loadURL(`app://scratchpad/index.html?${query}`);
    return m;
  }

  createCapture() {
    if (!this.capture) this.capture = this.create('capture', undefined, false);
  }

  showMain() {
    if (!this.main || this.main.win.isDestroyed()) this.main = this.create('main');
    this.present(this.main);
  }

  showCapture(params: { mode?: string; draftId?: string }) {
    this.createCapture();
    const m = this.capture!;
    m.win.webContents.send('win:summon', params);
    this.present(m);
  }

  openDraft(id: string) {
    const existing = this.drafts.get(id);
    if (existing && !existing.win.isDestroyed()) return this.present(existing);
    const m = this.create('draft', id);
    this.drafts.set(id, m);
    this.state.update(m.key, { draftId: id });
  }

  closeDraftWindow(m: Managed) {
    this.state.forget(m.key);
    m.win.close();
  }

  /**
   * Hides a window. On macOS, when that leaves nothing showing, the app hides
   * too, so focus goes back to whatever you were typing in before the hotkey.
   */
  hide(m: Managed) {
    m.win.hide();
    if (isMac && !BrowserWindow.getAllWindows().some((w) => w.isVisible())) app.hide();
  }

  /**
   * Shows and focuses a window. On KDE Wayland, KWin has to do the focusing;
   * on macOS, the app has to be brought forward from behind the one in use.
   */
  private present(m: Managed) {
    if (isMac) app.show();
    m.win.show();
    if (isMac) app.focus({ steal: true });
    m.win.focus();
    if (useKwin()) {
      setTimeout(() => {
        if (m.win.isDestroyed()) return;
        const float = this.state.get(m.key).float;
        kwinApply(process.pid, m.win.getTitle(), { activate: true, keepAbove: float || undefined }).catch((e) =>
          console.error('scratchpad: KWin activation failed', e),
        );
      }, 120);
    }
  }

  async setFloat(m: Managed, on: boolean) {
    this.state.update(m.key, { float: on });
    await this.applyFloat(m, on);
    return on;
  }

  private async applyFloat(m: Managed, on: boolean) {
    if (m.win.isDestroyed()) return;
    if (useKwin()) {
      await kwinApply(process.pid, m.win.getTitle(), { keepAbove: on }).catch((e) =>
        console.error('scratchpad: KWin keep-above failed', e),
      );
    } else {
      m.win.setAlwaysOnTop(on, 'floating');
    }
  }
}
