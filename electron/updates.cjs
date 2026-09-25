'use strict'
/**
 * The installed app keeps itself up to date.
 *
 * Install Scrumly-Setup-x.y.z.exe once. After that every launch, and every six
 * hours while the window stays open, asks GitHub for the latest release. A
 * newer version downloads in the background and installs when Scrumly closes;
 * a dialog offers to restart into it straight away. What gets read is
 * latest.yml, which the release workflow attaches next to the installer: it
 * names the version and the installer's checksum. The data is not touched —
 * it lives under userData or the chosen data folder, never next to the exe.
 *
 * Not for the portable exe: it is a single file with nowhere to install into,
 * and "updating" it would mean running the installer over it. Not for a dev
 * run either, and only on Windows, the one platform a release is built for.
 */
const { app, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')

const RECHECK_MS = 6 * 60 * 60 * 1000

let windowOf = () => null
let flush = async () => {}
/** The version waiting to be installed, once it has finished downloading. */
let ready = null
let offered = null

function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

function supported() {
  return app.isPackaged && process.platform === 'win32' && !isPortable()
}

function show(options) {
  const win = windowOf()
  return win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options)
}

/**
 * Checks and, if there is something newer, starts the download. Resolves to
 * the newer version, or null when this is already the latest.
 */
async function check() {
  const result = await autoUpdater.checkForUpdates()
  if (!result?.downloadPromise) return null
  // The download's own failure is reported through the updater's error event;
  // this only keeps it from surfacing as an unhandled rejection.
  result.downloadPromise.catch(() => {})
  return result.updateInfo.version
}

async function offerRestart(version) {
  offered = version
  const { response } = await show({
    type: 'info',
    title: 'Update ready',
    message: `Scrumly ${version} is ready`,
    detail: 'It installs the next time you close Scrumly. Restart now to start using it straight away.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return
  // The installer closes Scrumly and then kills it if it is slow to go, so
  // write the last changes out first rather than trusting the close handler.
  await flush()
  autoUpdater.quitAndInstall(true, true)
}

/**
 * Starts checking in the background. `getWindow` is for parenting dialogs;
 * `flushData` writes the renderer's pending changes to disk.
 */
function start({ getWindow, flushData }) {
  if (!supported()) return
  windowOf = getWindow
  flush = flushData

  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version
    // A later check finds the same download in the cache and says so again.
    if (offered !== info.version) void offerRestart(info.version)
  })

  const quietly = () => {
    if (ready) return
    check().catch(() => { /* offline, or GitHub is down: try again later */ })
  }
  quietly()
  setInterval(quietly, RECHECK_MS)
}

/** Help → Check for updates: the same check, with an answer either way. */
async function checkNow() {
  const current = app.getVersion()
  if (!supported()) {
    await show({
      type: 'info',
      title: 'Updates',
      message: `This is Scrumly ${current}`,
      detail: isPortable()
        ? 'The portable exe does not update itself. Install Scrumly with Scrumly-Setup from the releases page and it will keep itself up to date.'
        : 'Only the installed app updates itself.',
    })
    return
  }
  if (ready) return offerRestart(ready)

  try {
    const newer = await check()
    await show({
      type: 'info',
      title: 'Updates',
      message: newer ? `Downloading Scrumly ${newer}` : `Scrumly ${current} is the latest version`,
      detail: newer ? 'You will be asked to restart once it has downloaded.' : undefined,
    })
  } catch (err) {
    await show({
      type: 'warning',
      title: 'Updates',
      message: 'Could not check for updates',
      detail: err?.message ?? String(err),
    })
  }
}

module.exports = { start, checkNow }
