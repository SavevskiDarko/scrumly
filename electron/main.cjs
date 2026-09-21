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

// Every date Scrumly renders itself is dd/mm/yyyy (src/lib/dates.ts), but
// <input type="date"> is drawn by Chromium in its own UI locale, and there is
// no way to set that from the page. On a US-locale machine the sprint and due
// date pickers came out mm/dd/yyyy while the text beside them read dd/mm/yyyy,
// which is the one combination guaranteed to be misread. en-GB is the nearest
// locale whose short date is dd/mm/yyyy; the app's own strings are English
// already, so nothing else about it changes.
app.commandLine.appendSwitch('lang', 'en-GB')

const storage = require('./storage.cjs')

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
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc() {
  ipcMain.handle('scrumly:info', () => storage.info())
  ipcMain.handle('scrumly:load', () => storage.read())
  ipcMain.handle('scrumly:save', (_e, snapshot) => storage.write(snapshot))
  ipcMain.handle('scrumly:reveal', async () => { void shell.openPath(await storage.dataDir()) })

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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
