'use strict'
/**
 * The only thing the renderer can reach from the main process.
 *
 * Deliberately five functions and no filesystem: the app gets "give me the
 * saved data" and "here is the current data", not a path it could write
 * anywhere. Node stays off in the renderer, contextIsolation stays on, and
 * anything Excalidraw or a future dependency pulls in cannot touch the disk.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('scrumlyDesktop', {
  /** Marks this build as the desktop one; the browser has no such object. */
  version: process.versions.electron,
  info: () => ipcRenderer.invoke('scrumly:info'),
  load: () => ipcRenderer.invoke('scrumly:load'),
  save: (snapshot) => ipcRenderer.invoke('scrumly:save', snapshot),
  chooseDir: () => ipcRenderer.invoke('scrumly:choose-dir'),
  reveal: () => ipcRenderer.invoke('scrumly:reveal'),
})
