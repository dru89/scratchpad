// scratchpad's Electron main process: window management, the `ui` client
// connection to the daemon, and the few things a sandboxed renderer can't do
// (clipboard with HTML, native menus, KWin).

import { app, BrowserWindow, ClipboardItem, clipboard, ipcMain, Menu, net, protocol } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppClient } from './daemon';
import { StateStore, Windows } from './windows';

const IDLE_MS = Number(process.env.SCRATCHPAD_IDLE_MS) || 15 * 60 * 1000;
const RENDERER = join(__dirname, '..', 'dist-renderer');

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
    summon(windows, process.argv);

    daemon = new AppClient();
    daemon.on('ui.capture', (p) => windows.showCapture(p ?? {}));
    daemon.on('ui.open', (p) => p?.id && windows.openDraft(p.id));

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] },
        // No undo/redo roles: native undo would bypass the editor's own,
        // which only reverts this window's edits.
        {
          label: 'Edit',
          submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
        },
        { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      ]),
    );

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
    ipcMain.on('win:hide', (e) => managed(e).win.hide());
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
  app.on('will-quit', () => state?.flush());
}
