// Electron shell for the shell test. Mirrors tauri/src/main.rs command for
// command so the two differ only in engine and IPC.

const { app, BrowserWindow, clipboard, ipcMain, net, protocol } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const netSocket = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'editor', 'dist');
const FIXTURES = path.join(ROOT, 'fixtures');
const RESULTS = path.join(ROOT, 'results');
const SCRIPTS = path.join(ROOT, 'scripts');
const SOCK = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'scratchpad-spike.sock');

const VARIANT = process.env.SPIKE_VARIANT || 'electron';
const AUTORUN = process.env.SPIKE_AUTORUN === '1';
const LAUNCH_MS = process.env.SPIKE_LAUNCH_MS ? Number(process.env.SPIKE_LAUNCH_MS) : null;

const wallNow = () => performance.timeOrigin + performance.now();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const windows = new Map(); // label -> BrowserWindow
const labels = new Map(); // webContents.id -> label
const pending = new Map(); // label -> { t0, mode, autoHide }
const timings = [];
let coldCount = 0;
let quitting = false;

function titleFor(label) {
  if (label === 'main') return 'scratchpad spike — main';
  if (label === 'capture-warm') return 'scratchpad spike — capture';
  return `scratchpad spike — ${label}`;
}

function createWindow(label, { width, height, show, alwaysOnTop = false }) {
  const win = new BrowserWindow({
    title: titleFor(label),
    width,
    height,
    show,
    alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('console-message', (e, ...legacy) => {
    console.log(`[${label}] ${e.message ?? legacy[1]}`);
  });
  labels.set(win.webContents.id, label);
  windows.set(label, win);
  win.on('closed', () => windows.delete(label));
  win.loadURL(`app://spike/index.html?label=${encodeURIComponent(label)}`);
  return win;
}

function createCapture(label, show) {
  return createWindow(label, { width: 560, height: 380, show, alwaysOnTop: true });
}

function openCapture(mode, autoHide) {
  if (mode === 'warm') {
    const win = windows.get('capture-warm');
    if (!win) throw new Error('no warm capture window');
    pending.set('capture-warm', { t0: wallNow(), mode, autoHide });
    win.show();
    win.focus();
    win.webContents.send('capture-shown');
  } else {
    const label = `capture-cold-${++coldCount}`;
    pending.set(label, { t0: wallNow(), mode, autoHide });
    createCapture(label, true);
  }
}

function runScript(file, args) {
  return new Promise((resolve, reject) => {
    execFile(path.join(SCRIPTS, file), args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

ipcMain.handle('info', async () => ({
  shell: 'electron',
  variant: VARIANT,
  autorun: AUTORUN,
  pid: process.pid,
  launchMs: LAUNCH_MS,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    v8: process.versions.v8,
  },
  ozonePlatformSwitch: app.commandLine.getSwitchValue('ozone-platform') || '(default)',
  gpu: await app.getGPUInfo('basic').catch((e) => String(e)),
  gpuFeatures: app.getGPUFeatureStatus(),
}));

ipcMain.handle('loadFixture', (_e, name) => {
  if (name.includes('/')) throw new Error('bad fixture name');
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
});

ipcMain.handle('saveResult', (_e, name, data) => {
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${name.replace(/[^\w.-]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
});

ipcMain.handle('memory', async () => JSON.parse(await runScript('mem.py', [String(process.pid)])));

ipcMain.handle('copyRich', (_e, html, text) => clipboard.write({ html, text }));

ipcMain.handle('keepAbove', (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return runScript('kwin-keep-above.sh', [String(process.pid), win.getTitle(), on ? 'true' : 'false']);
});

ipcMain.handle('openCapture', (_e, mode, autoHide) => openCapture(mode, autoHide));

ipcMain.handle('reportFrame', (e, ts) => {
  const recv = wallNow();
  const label = labels.get(e.sender.id);
  const p = pending.get(label);
  if (!p) return;
  pending.delete(label);
  timings.push({ label, mode: p.mode, ms: ts - p.t0, rttMs: recv - p.t0 });
  if (p.autoHide) {
    setTimeout(() => {
      const win = windows.get(label);
      if (!win) return;
      if (p.mode === 'warm') win.hide();
      else win.destroy();
    }, 400);
  }
});

ipcMain.handle('captureTimings', () => timings);

ipcMain.handle('quit', () => {
  quitting = true;
  app.quit();
});

function startSocket() {
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  const server = netSocket.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const [cmd, ...rest] = buf.slice(0, i).trim().split(/\s+/);
        buf = buf.slice(i + 1);
        if (rest.length) console.log(`socket: ${cmd} (activation token ${rest[0]})`);
        if (cmd === 'capture') openCapture('warm', false);
        else if (cmd === 'capture-cold') openCapture('cold', false);
        else if (cmd === 'quit') app.quit();
      }
    });
  });
  server.listen(SOCK);
  app.on('will-quit', () => {
    server.close();
    try {
      fs.unlinkSync(SOCK);
    } catch {}
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.join(DIST, decodeURIComponent(pathname));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const main = createWindow('main', { width: 1100, height: 900, show: true });
  main.on('closed', () => {
    quitting = true;
    app.quit();
  });

  const warm = createCapture('capture-warm', false);
  warm.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    warm.hide();
  });

  startSocket();
});

app.on('before-quit', () => {
  quitting = true;
});
