// The only bridge between a sandboxed window and the main process. Kept free
// of ES module syntax so it compiles to a plain script sandboxed preloads
// can run.

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('scratchpad', {
  daemon: {
    send: (line: string) => ipcRenderer.send('daemon:send', line),
    onLine: (cb: (line: string) => void) => ipcRenderer.on('daemon:line', (_e, line) => cb(line)),
    onStatus: (cb: (s: { connected: boolean }) => void) => ipcRenderer.on('daemon:status', (_e, s) => cb(s)),
  },
  info: () => ipcRenderer.invoke('win:info'),
  savePrefs: (patch: object) => ipcRenderer.invoke('win:savePrefs', patch),
  setTitle: (title: string) => ipcRenderer.send('win:setTitle', title),
  setFloat: (on: boolean) => ipcRenderer.invoke('win:setFloat', on),
  hide: () => ipcRenderer.send('win:hide'),
  close: () => ipcRenderer.send('win:close'),
  onSummon: (cb: (p: { mode?: string; draftId?: string }) => void) => ipcRenderer.on('win:summon', (_e, p) => cb(p)),
  openDraft: (id: string) => ipcRenderer.invoke('app:openDraft', id),
  openInCapture: (id: string) => ipcRenderer.invoke('app:openInCapture', id),
  showMain: () => ipcRenderer.invoke('app:showMain'),
  contextMenu: (items: object[]) => ipcRenderer.invoke('app:contextMenu', items),
  onMenuAction: (cb: (action: string) => void) => ipcRenderer.on('menu:action', (_e, action) => cb(action)),
  copyRich: (markdown: string) => ipcRenderer.invoke('clipboard:copyRich', markdown),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:copyText', text),
  emptyTrash: () => ipcRenderer.invoke('app:emptyTrash'),
  exportDraft: (id: string) => ipcRenderer.invoke('app:exportDraft', id),
  quit: () => ipcRenderer.invoke('app:quit'),
});
