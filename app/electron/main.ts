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

/** What the command line asks for: see app/bin/scratchpad-app. */
function summon(windows: Windows, argv: string[]) {
  const value = (flag: string) => argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  if (argv.includes('--capture')) {
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

function buildMenu(): Menu {
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
  if (!isMac) {
    return Menu.buildFromTemplate([{ label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] }, edit, view]);
  }
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
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
    { label: 'File', submenu: [{ role: 'close' }] },
    edit,
    view,
    { role: 'windowMenu' },
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let windows: Windows;
  let daemon: AppClient;
  let state: StateStore | undefined;

  app.on('second-instance', (_e, argv) => {
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
    // Opened at login on macOS counts as --background: ready for the hotkey, nothing shown.
    const atLogin = isMac && app.getLoginItemSettings().wasOpenedAtLogin;
    summon(windows, atLogin ? [...process.argv, '--background'] : process.argv);

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

    Menu.setApplicationMenu(buildMenu());

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
    ipcMain.handle('app:contextMenu', (e, items: { id: string; label: string }[]) => {
      return new Promise<string | null>((resolve) => {
        const menu = Menu.buildFromTemplate(
          items.map((item) =>
            item.id === '-' ? { type: 'separator' as const } : { label: item.label, click: () => resolve(item.id) },
          ),
        );
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
    ipcMain.handle('app:quit', () => app.quit());
  });

  // Write out window state still waiting on its debounce.
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    state?.flush();
  });
}
