// status-preload.js — narrow IPC bridge for the built-in status page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopStatus', {
  restart: () => ipcRenderer.invoke('backend:restart'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  logTail: () => ipcRenderer.invoke('logs:tail', 'backend'),
})
