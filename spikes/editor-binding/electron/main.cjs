// Electron shell for the binding spike. Each window gets its own connection
// to the daemon; this process only pipes lines between them, and starts the
// daemon when nothing is listening (the lifecycle from docs/design.md).

const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const netSocket = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'editor', 'dist');
const RESULTS = path.join(ROOT, 'results');
const DAEMON = path.join(ROOT, 'daemon', 'target', 'release', 'spike-daemon');
const SOCK = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'scratchpad-spike', 'daemon.sock');
const AUTORUN = process.env.SPIKE_AUTORUN === '1';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const conns = new Map(); // webContents.id -> { socket, closed }
let lastSpawn = 0;

function spawnDaemon() {
  if (Date.now() - lastSpawn < 2000) return;
  lastSpawn = Date.now();
  const log = fs.openSync(path.join(RESULTS, 'daemon.log'), 'a');
  spawn(DAEMON, [], { detached: true, stdio: ['ignore', log, log] }).unref();
}

function connect(wc) {
  if (wc.isDestroyed()) return;
  const state = { socket: null, closed: false, retry: 50 };
  conns.set(wc.id, state);
  const attempt = () => {
    if (wc.isDestroyed()) return;
    const socket = netSocket.createConnection(SOCK);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      state.socket = socket;
      state.retry = 50;
      wc.send('daemon:status', { connected: true });
    });
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!wc.isDestroyed()) wc.send('daemon:line', line);
      }
    });
    socket.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') spawnDaemon();
    });
    socket.on('close', () => {
      const wasConnected = state.socket === socket;
      state.socket = null;
      if (wasConnected && !wc.isDestroyed()) wc.send('daemon:status', { connected: false });
      if (!state.closed) setTimeout(attempt, (state.retry = Math.min(state.retry * 2, 1000)));
    });
  };
  attempt();
}

function createWindow(query) {
  const win = new BrowserWindow({
    width: query.role === 'observer' ? 700 : 1100,
    height: 900,
    title: `binding spike — ${query.role}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('console-message', (e, ...legacy) => console.log(`[${query.role}] ${e.message ?? legacy[1]}`));
  const wcId = win.webContents.id;
  win.webContents.on('did-finish-load', () => connect(win.webContents));
  win.on('closed', () => {
    const c = conns.get(wcId);
    if (c) {
      c.closed = true;
      c.socket?.destroy();
    }
    conns.delete(wcId);
  });
  const qs = new URLSearchParams({ ...query, autorun: AUTORUN ? '1' : '0', ...(process.env.SPIKE_ONLY ? { only: process.env.SPIKE_ONLY } : {}) });
  win.loadURL(`app://spike/index.html?${qs}`);
  return win;
}

ipcMain.on('daemon:send', (e, line) => {
  conns.get(e.sender.id)?.socket?.write(line + '\n');
});

ipcMain.on('spike:broadcast', (e, msg) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id !== e.sender.id) win.webContents.send('spike:message', msg);
  }
});

ipcMain.handle('spike:openWindow', (_e, query) => {
  createWindow(query);
});

ipcMain.handle('spike:save', (_e, name, data) => {
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
});

ipcMain.handle('spike:quit', () => app.quit());

app.whenReady().then(() => {
  fs.mkdirSync(RESULTS, { recursive: true });
  protocol.handle('app', (req) => {
    const file = path.join(DIST, decodeURIComponent(new URL(req.url).pathname));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const query = { role: 'main', doc: process.env.SPIKE_DOC || 'large' };
  // Recreate the draft from the fixture on every launch unless SPIKE_KEEP=1.
  if (process.env.SPIKE_KEEP !== '1') query.fixture = path.join(ROOT, 'fixtures', 'large.md');
  createWindow(query);
});

app.on('window-all-closed', () => app.quit());
