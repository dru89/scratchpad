const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spikeElectron', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args)),
});
