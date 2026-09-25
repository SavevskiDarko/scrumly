'use strict'
/**
 * Scrumly as a desktop app.
 *
 * Two things this buys over a browser tab, and they are the reason it exists:
 *
 *   - Its own window, taskbar entry and Start menu entry. No address bar, no
 *     tab to lose, no dev server to remember to start.
 *   - A stable home for the data. In a browser, IndexedDB is keyed to the
 *     origin — scheme, host *and port* — inside one browser profile, so
 *     localhost:5173 and localhost:5183 are two different databases and
 *     clearing site data empties both. Here the packaged app is served from a
 *     fixed app:// origin that never changes, and the copy that actually
 *     matters is a JSON file on disk (see storage.cjs).
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Before anything asks for userData: this decides the folder name under
// %APPDATA%, and renaming it later would orphan the config written into it.
app.setName('Scrumly')

// No --lang switch here on purpose. It looks like the fix for date fields
// rendering mm/dd/yyyy and is not: it moves navigator.language and Intl, and
// leaves <input type="date"> exactly where it was, because Chromium draws that
// control from the machine's regional format. Captured both ways to be sure.
// src/components/DateField.tsx is the actual fix.

const storage = require('./storage.cjs')
const jira = require('./jira.cjs')
const updates = require('./updates.cjs')

const DIST = path.join(__dirname, '..', 'dist')
const DEV_URL = process.env.SCRUMLY_DEV_URL || null
const APP_ORIGIN = 'app://scrumly'

/**
 * The packaged app is served over a custom scheme rather than loaded from
 * file://. Chromium treats every file:// document as its own opaque origin and
 * refuses IndexedDB there; app:// declared as standard and secure behaves like
 * a normal https origin, and never changes between versions.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

function serveDist() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    let rel = decodeURIComponent(url.pathname)
    // Hash routing means every real route is '/', and the router reads the
    // fragment. Anything without an extension is the shell, not a missing file.
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'

    const file = path.join(DIST, rel)
    // path.join collapses '..', so this catches an escape attempt after
    // normalisation rather than trusting the incoming string.
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    // The window is sized and positioned before the renderer has painted;
    // showing it only once ready avoids a white flash on a dark theme.
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Scrumly',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })

  // Closing the window is the usual way this app ends, and the renderer is
  // torn down before app-level quit handlers get a look in. So the flush hangs
  // off the close itself: hold it open, write, then really close.
  let flushed = false
  mainWindow.on('close', (e) => {
    if (flushed) return
    e.preventDefault()
    void flushRenderer().finally(() => {
      flushed = true
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    })
  })

  // Excalidraw's help links and anything else external belong in the real
  // browser; a Scrumly window that can navigate away from Scrumly is a trap.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Prefix, not origin: URL.origin is the string 'null' for a non-special
  // scheme like app://, and a dev reload arrives as '.../' against a DEV_URL
  // written without the trailing slash.
  const home = (DEV_URL || APP_ORIGIN).replace(/\/$/, '')
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(home)) return
    e.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  if (DEV_URL) void mainWindow.loadURL(DEV_URL)
  else void mainWindow.loadURL(`${APP_ORIGIN}/`)
}

/**
 * Asks the renderer to flush, and waits for it. Used before quitting so a
 * change made in the last couple of seconds is not lost to the debounce.
 */
async function flushRenderer() {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return
  try {
    await Promise.race([
      mainWindow.webContents.executeJavaScript('window.__scrumlyFlush?.() ?? null', true),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  } catch {
    /* the renderer is already gone; the last debounced write is all there is */
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Save data now',
          accelerator: 'CmdOrCtrl+S',
          click: () => { void flushRenderer() },
        },
        {
          label: 'Open data folder',
          click: async () => { void shell.openPath(await storage.dataDir()) },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for updates…', click: () => { void updates.checkNow() } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc() {
  ipcMain.handle('scrumly:info', () => storage.info())
  ipcMain.handle('scrumly:load', () => storage.read())
  ipcMain.handle('scrumly:save', (_e, snapshot) => storage.write(snapshot))
  // What is kept on this computer only: always the same folder under userData.
  ipcMain.handle('scrumly:load-local', () => storage.readLocal())
  ipcMain.handle('scrumly:save-local', (_e, snapshot) => storage.writeLocal(snapshot))
  ipcMain.handle('scrumly:reveal', async () => { void shell.openPath(await storage.dataDir()) })

  // The token goes in through connect and never comes back out: status reports
  // who is connected, and request returns Jira's data, not the credentials.
  ipcMain.handle('scrumly:jira-status', () => jira.status())
  ipcMain.handle('scrumly:jira-connect', (_e, input) => jira.connect(input))
  ipcMain.handle('scrumly:jira-disconnect', () => jira.disconnect())
  ipcMain.handle('scrumly:jira-get', (_e, apiPath) => jira.request(apiPath))

  ipcMain.handle('scrumly:choose-dir', async () => {
    const options = {
      title: 'Where should Scrumly keep its data?',
      defaultPath: await storage.dataDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    if (storage.isLocalDir(result.filePaths[0])) {
      dialog.showErrorBox('Choose another folder',
        'That folder holds what is kept on this computer only. The data file needs a folder of its own.')
      return null
    }
    await storage.setDataDir(result.filePaths[0])
    return storage.info()
  })
}

// A second launch should raise the window that is already open, not start a
// second app writing the same file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    if (!DEV_URL) serveDist()
    registerIpc()
    buildMenu()
    createWindow()
    updates.start({ getWindow: () => mainWindow, flushData: flushRenderer })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
