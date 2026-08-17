// settings-preload.js — narrow IPC bridge for the built-in settings window.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopSettings', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:patch', patch),
  backendInfo: () => ipcRenderer.invoke('backend:info'),
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  onUpdateLog: (cb) => ipcRenderer.on('update:log', (_e, line) => cb(line)),
  onUpdateDone: (cb) => ipcRenderer.on('update:done', (_e, r) => cb(r)),
})
