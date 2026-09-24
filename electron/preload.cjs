'use strict'
/**
 * The only thing the renderer can reach from the main process.
 *
 * Deliberately a few functions and no filesystem: the app gets "give me the
 * saved data" and "here is the current data", not a path it could write
 * anywhere. Node stays off in the renderer, contextIsolation stays on, and
 * anything Excalidraw or a future dependency pulls in cannot touch the disk.
 *
 * Jira gets the same treatment: the renderer can hand over a token and ask
 * for read-only API paths, but can never read the token back.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('scrumlyDesktop', {
  /** Marks this build as the desktop one; the browser has no such object. */
  version: process.versions.electron,
  info: () => ipcRenderer.invoke('scrumly:info'),
  load: () => ipcRenderer.invoke('scrumly:load'),
  save: (snapshot) => ipcRenderer.invoke('scrumly:save', snapshot),
  loadLocal: () => ipcRenderer.invoke('scrumly:load-local'),
  saveLocal: (snapshot) => ipcRenderer.invoke('scrumly:save-local', snapshot),
  chooseDir: () => ipcRenderer.invoke('scrumly:choose-dir'),
  reveal: () => ipcRenderer.invoke('scrumly:reveal'),
  jira: {
    status: () => ipcRenderer.invoke('scrumly:jira-status'),
    connect: (input) => ipcRenderer.invoke('scrumly:jira-connect', input),
    disconnect: () => ipcRenderer.invoke('scrumly:jira-disconnect'),
    get: (apiPath) => ipcRenderer.invoke('scrumly:jira-get', apiPath),
  },
})
