const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  send: (line) => ipcRenderer.send('daemon:send', line),
  onLine: (cb) => ipcRenderer.on('daemon:line', (_e, line) => cb(line)),
  onStatus: (cb) => ipcRenderer.on('daemon:status', (_e, s) => cb(s)),
  broadcast: (msg) => ipcRenderer.send('spike:broadcast', msg),
  onMessage: (cb) => ipcRenderer.on('spike:message', (_e, msg) => cb(msg)),
  openWindow: (query) => ipcRenderer.invoke('spike:openWindow', query),
  save: (name, data) => ipcRenderer.invoke('spike:save', name, data),
  quit: () => ipcRenderer.invoke('spike:quit'),
});
