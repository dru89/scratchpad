// scratchpad's Electron main process: window management, the `ui` client
// connection to the daemon, and the few things a sandboxed renderer can't do
// (clipboard with HTML, native menus, KWin, the macOS capture hotkey).

import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  net,
  protocol,
} from 'electron';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppClient } from './daemon';
import { checkNow, restartToUpdate, startUpdates, updateReady, updatesEnabled } from './updates';
import { StateStore, Windows } from './windows';

const IDLE_MS = Number(process.env.SCRATCHPAD_IDLE_MS) || 15 * 60 * 1000;
const RENDERER = join(__dirname, '..', 'dist-renderer');
const isMac = process.platform === 'darwin';
/**
 * The capture hotkey on macOS, where an app can register one itself. On
 * Linux it's a desktop shortcut that runs `scratchpad capture`
 * (app/scripts/install-linux.sh), because Wayland doesn't let apps grab keys.
 */
const CAPTURE_HOTKEY = 'Command+Shift+2';

if (process.env.SCRATCHPAD_APP_STATE_DIR) app.setPath('userData', process.env.SCRATCHPAD_APP_STATE_DIR);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/**
 * Opens a scratchpad:// link: scratchpad://open/<id> opens that draft in its
 * own window, and scratchpad://capture summons the capture window. macOS
 * delivers links through open-url; Linux passes them on the command line.
 */
function openLink(windows: Windows, url: string) {
  let link: URL;
  try {
    link = new URL(url);
  } catch {
    return;
  }
  if (link.protocol !== 'scratchpad:') return;
  const id = link.pathname.slice(1);
  if (link.host === 'open' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) windows.openDraft(id.toUpperCase());
  else if (link.host === 'capture') windows.showCapture({ mode: 'summon' });
}

/** What the command line asks for: see app/bin/scratchpad-app. */
function summon(windows: Windows, argv: string[]) {
  const value = (flag: string) => argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const links = argv.filter((a) => a.startsWith('scratchpad://'));
  if (links.length) {
    for (const link of links) openLink(windows, link);
  } else if (argv.includes('--capture')) {
    const draftId = value('--draft');
    windows.showCapture({ mode: argv.includes('--new') ? 'new' : draftId ? 'load' : 'summon', draftId });
  } else if (value('--open')) {
    windows.openDraft(value('--open')!);
  } else if (!argv.includes('--background')) {
    windows.showMain();
  }
}

/** Links the bundled CLI into ~/.local/bin, from the app menu on macOS. */
async function installCli() {
  const target = join(process.resourcesPath, 'bin', 'scratchpad');
  const dir = join(homedir(), '.local', 'bin');
  const link = join(dir, 'scratchpad');
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(target, link);
    await dialog.showMessageBox({
      message: 'Installed the scratchpad command',
      detail: `${link} now runs the command-line tool in this app. If your shell can't find it, add ~/.local/bin to your PATH.`,
    });
  } catch (e) {
    await dialog.showMessageBox({ type: 'warning', message: "Couldn't install the scratchpad command", detail: String(e) });
  }
}

/** A context menu item from a window: `id` "-" is a separator. */
interface ContextItem {
  id: string;
  label: string;
  submenu?: ContextItem[];
}

interface MenuHandlers {
  emptyTrash(): void;
  restartToUpdate(): void;
}

/**
 * The Draft menu: actions on the focused window's draft, carried out by that
 * window. On Linux the window handles the keys itself and the menu only shows
 * them; on macOS the menu has to take them.
 */
function draftMenu(): MenuItemConstructorOptions {
  const item = (label: string, action: string, accelerator?: string): MenuItemConstructorOptions => ({
    id: action,
    label,
    accelerator,
    registerAccelerator: isMac,
    click: (_item, win) => {
      const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow();
      target?.webContents.send('menu:action', action);
    },
  });
  return {
    label: 'Draft',
    submenu: [
      item('New Draft', 'newDraft', 'CmdOrCtrl+N'),
      { type: 'separator' },
      item('Pin', 'pin', 'CmdOrCtrl+Shift+P'),
      item('Float on Top', 'float', 'CmdOrCtrl+Shift+F'),
      { type: 'separator' },
      item('Copy as Rich Text', 'copyRich', 'CmdOrCtrl+Shift+C'),
      {
        label: 'Copy',
        submenu: [
          item('Contents', 'copyContents'),
          item('Title', 'copyTitle'),
          item('Link', 'copyLink'),
          item('ID', 'copyId'),
        ],
      },
      { type: 'separator' },
      item('Duplicate', 'duplicate'),
      item('Get Info', 'info', 'CmdOrCtrl+I'),
      item('Open in New Window', 'openWindow', 'CmdOrCtrl+Shift+O'),
      { type: 'separator' },
      item('Archive', 'archive', 'CmdOrCtrl+Shift+A'),
      item('Move to Trash', 'trash', 'CmdOrCtrl+Shift+Backspace'),
    ],
  };
}

function buildMenu(handlers: MenuHandlers): Menu {
  // No undo/redo roles in Edit: native undo would bypass the editor's own,
  // which only reverts this window's edits.
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
  };
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [{ role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
  };
  const emptyTrash: MenuItemConstructorOptions = { id: 'emptyTrash', label: 'Empty Trash…', click: handlers.emptyTrash };
  if (!isMac) {
    return Menu.buildFromTemplate([
      { label: 'File', submenu: [emptyTrash, { type: 'separator' }, { role: 'close' }, { role: 'quit' }] },
      edit,
      draftMenu(),
      view,
    ]);
  }
  const updates: MenuItemConstructorOptions[] = !updatesEnabled()
    ? []
    : updateReady()
      ? [{ label: 'Restart to Update', click: handlers.restartToUpdate }]
      : [{ label: 'Check for Updates…', click: () => void checkNow() }];
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        ...updates,
        { type: 'separator' },
        {
          label: 'Open at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        ...(app.isPackaged ? [{ label: 'Install Command Line Tool…', click: () => void installCli() }] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: [emptyTrash, { type: 'separator' }, { role: 'close' }] },
    edit,
    draftMenu(),
    view,
    { role: 'windowMenu' },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes('--quit')) {
  // --quit asks a running app to quit (below); with none running, there's nothing to do.
  app.quit();
} else {
  let windows: Windows;
  let daemon: AppClient;
  let state: StateStore | undefined;
  // Links that arrive before the app is ready, as when one launches it.
  const pendingLinks: string[] = [];

  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (windows) openLink(windows, url);
    else pendingLinks.push(url);
  });

  /** Empty Trash…, from the File menu and the Trash tab: confirms, then deletes. */
  async function emptyTrash(parent?: BrowserWindow | null) {
    const { drafts } = await daemon.call<{ drafts: unknown[] }>('drafts.list', { states: ['trashed'], limit: 100_000 });
    if (!drafts.length) return;
    const n = drafts.length;
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: `Permanently delete ${n === 1 ? 'the draft' : `the ${n} drafts`} in the Trash?`,
      detail: "You can't undo this.",
      buttons: ['Empty Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response === 0) await daemon.call('drafts.emptyTrash');
  }

  const menuHandlers: MenuHandlers = {
    emptyTrash: () => void emptyTrash(BrowserWindow.getFocusedWindow()).catch((e) => console.error('scratchpad:', e)),
    restartToUpdate: () =>
      restartToUpdate(() => {
        if (windows) windows.quitting = true;
      }),
  };

  app.on('second-instance', (_e, argv) => {
    // --quit, from app/scripts/update-linux.sh: quit as the menu would.
    if (argv.includes('--quit')) return app.quit();
    // Autostart while already running: nothing to do. A plain second launch
    // (the app icon) shows the main window.
    if (!argv.includes('--background')) summon(windows, argv);
  });

  app.on('before-quit', () => {
    if (windows) windows.quitting = true;
  });

  // macOS: clicking the Dock icon with no window showing brings back the main one.
  app.on('activate', (_e, hasVisibleWindows) => {
    if (windows && !hasVisibleWindows) windows.showMain();
  });

  // The capture window stays alive (hidden), so this rarely fires; when it
  // does, keep running for the next hotkey press.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const file = join(RENDERER, decodeURIComponent(new URL(req.url).pathname));
      if (!file.startsWith(RENDERER)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    state = new StateStore();
    windows = new Windows(state);
    windows.createCapture();
    // Opened at login on macOS counts as --background: ready for the hotkey,
    // nothing shown. So does being opened by a link, which opens its own window.
    const atLogin = isMac && app.getLoginItemSettings().wasOpenedAtLogin;
    summon(windows, atLogin || pendingLinks.length ? [...process.argv, '--background'] : process.argv);
    for (const link of pendingLinks.splice(0)) openLink(windows, link);

    if (isMac) {
      if (!globalShortcut.register(CAPTURE_HOTKEY, () => windows.showCapture({ mode: 'summon' }))) {
        console.error(`scratchpad: couldn't register ${CAPTURE_HOTKEY}; another app may have it`);
      }
      // The hotkey only works while the app runs, so it starts at login
      // unless you've turned that off. Not for test runs, which set their
      // own state directory.
      if (app.isPackaged && !process.env.SCRATCHPAD_APP_STATE_DIR && !state.get('app').loginItemSet) {
        app.setLoginItemSettings({ openAtLogin: true });
        state.update('app', { loginItemSet: true });
      }
    }

    daemon = new AppClient();
    daemon.on('ui.capture', (p) => windows.showCapture(p ?? {}));
    daemon.on('ui.open', (p) => p?.id && windows.openDraft(p.id));

    Menu.setApplicationMenu(buildMenu(menuHandlers));
    startUpdates(() => Menu.setApplicationMenu(buildMenu(menuHandlers)));

    const managed = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
      const m = windows.managed(e.sender.id);
      if (!m) throw new Error('unknown window');
      return m;
    };

    ipcMain.on('daemon:send', (e, line: string) => windows.managed(e.sender.id)?.link?.send(line));
    ipcMain.handle('win:info', (e) => {
      const m = managed(e);
      return { kind: m.kind, prefs: windows.prefs(m), idleMs: IDLE_MS, platform: process.platform };
    });
    ipcMain.handle('win:savePrefs', (e, patch) => state?.update(managed(e).key, patch));
    ipcMain.on('win:setTitle', (e, title: string) => managed(e).win.setTitle(title));
    ipcMain.handle('win:setFloat', (e, on: boolean) => windows.setFloat(managed(e), on));
    ipcMain.on('win:hide', (e) => windows.hide(managed(e)));
    ipcMain.on('win:close', (e) => {
      const m = managed(e);
      if (m.kind === 'draft') windows.closeDraftWindow(m);
      else m.win.hide();
    });
    ipcMain.handle('app:openDraft', (_e, id: string) => windows.openDraft(id));
    ipcMain.handle('app:openInCapture', (_e, id: string) => windows.showCapture({ mode: 'load', draftId: id }));
    ipcMain.handle('app:showMain', () => windows.showMain());
    ipcMain.handle('app:contextMenu', (e, items: ContextItem[]) => {
      return new Promise<string | null>((resolve) => {
        const template = (list: ContextItem[]): MenuItemConstructorOptions[] =>
          list.map((item) =>
            item.id === '-'
              ? { type: 'separator' }
              : item.submenu
                ? { label: item.label, submenu: template(item.submenu) }
                : { label: item.label, click: () => resolve(item.id) },
          );
        const menu = Menu.buildFromTemplate(template(items));
        // The close callback can fire before the click; let the click win.
        menu.popup({
          window: BrowserWindow.fromWebContents(e.sender) ?? undefined,
          callback: () => setTimeout(() => resolve(null), 50),
        });
      });
    });
    ipcMain.handle('clipboard:copyRich', async (_e, markdown: string) => {
      const { html } = await daemon.call<{ html: string }>('drafts.render', { text: markdown });
      await clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': markdown })]);
    });
    ipcMain.handle('clipboard:copyText', (_e, text: string) => clipboard.writeText(text));
    ipcMain.handle('app:emptyTrash', (e) => emptyTrash(BrowserWindow.fromWebContents(e.sender)));
    ipcMain.handle('app:quit', () => app.quit());
  });

  // Write out window state still waiting on its debounce.
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    state?.flush();
  });
}
