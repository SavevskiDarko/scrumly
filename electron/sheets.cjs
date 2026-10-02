'use strict'
/**
 * The desktop side of the Sheets screen.
 *
 * A sheet shared with "anyone with the link" opens in a frame inside Scrumly.
 * A private one needs a Google account that can see it, and Google does not
 * let anyone sign in inside a desktop app: its sign-in page answers "This
 * browser or app may not be secure", on purpose, so that no app ever handles a
 * Google password. 0.3.9 tried a sign-in window here and Google turned it away.
 * That check is not something to get round.
 *
 * So a private sheet opens in a window of the browser the user already signs
 * in to Google with — Chrome or Edge in app mode: no tabs, no address bar, the
 * real editor, their real account, company single sign-on included. Scrumly
 * starts the window and sees nothing of it after that.
 */
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { shell } = require('electron')

const isSignInUrl = (url) => typeof url === 'string' && url.startsWith('https://accounts.google.com/')
// Checked here as well as in the renderer: this is the address a browser gets started with.
const isSheetUrl = (url) => typeof url === 'string' && url.startsWith('https://docs.google.com/spreadsheets/')

const USER_CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'

/** Windows' choice of browser for https links: 'ChromeHTML', 'MSEdgeHTM', 'FirefoxURL-…', or null. */
function defaultProgId() {
  return new Promise((resolve) => {
    execFile('reg', ['query', USER_CHOICE, '/v', 'ProgId'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : /ProgId\s+REG_SZ\s+(\S+)/.exec(stdout)?.[1] ?? null)
    })
  })
}

/**
 * The Chromium browser to open a sheet in, or null when there is none to
 * start directly. Chrome, then Edge — unless Edge is the default browser,
 * since the default is the one most likely signed in to Google. Windows only:
 * elsewhere the default browser gets an ordinary tab.
 */
function pickBrowser({ platform, env, exists, progId }) {
  if (platform !== 'win32') return null
  const under = (dirs, ...rest) => dirs.filter(Boolean).map((d) => path.win32.join(d, ...rest))
  const chrome = under([env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA], 'Google', 'Chrome', 'Application', 'chrome.exe')
  const edge = under([env['ProgramFiles(x86)'], env.ProgramFiles], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  const order = /^MSEdge/i.test(progId ?? '') ? [...edge, ...chrome] : [...chrome, ...edge]
  return order.find((p) => exists(p)) ?? null
}

const nameOf = (browser) => (/msedge\.exe$/i.test(browser) ? 'Edge' : 'Chrome')

/**
 * Opens a sheet in a window of its own. Resolves with where it went — 'Chrome',
 * 'Edge', or 'browser' for an ordinary tab when neither could be started — or
 * null for an address that is not a Google Sheet.
 */
async function openWindow(url) {
  if (!isSheetUrl(url)) return null
  const browser = pickBrowser({
    platform: process.platform,
    env: process.env,
    exists: fs.existsSync,
    progId: process.platform === 'win32' ? await defaultProgId() : null,
  })
  if (!browser) {
    await shell.openExternal(url)
    return 'browser'
  }
  return new Promise((resolve) => {
    // Hands the window to the browser's running copy when there is one, and
    // with it the profile that is signed in. No shell, so the address is one
    // argument whatever is in it.
    const child = spawn(browser, [`--app=${url}`], { detached: true, stdio: 'ignore' })
    child.once('spawn', () => { child.unref(); resolve(nameOf(browser)) })
    child.once('error', () => { void shell.openExternal(url).then(() => resolve('browser')) })
  })
}

/**
 * Tells the renderer when a sheet's frame ends up on Google's sign-in page,
 * which inside a frame answers only "401. That's an error." — so the screen
 * covers it and offers the window instead. Landing is what counts, not
 * passing through: Docs bounces its own inner frames off the sign-in page and
 * straight back on every sheet, public ones included. The sign-in address
 * carries the sheet it would continue to, which says which frame it was.
 */
function watch(contents) {
  const needed = (url, isMainFrame) => {
    if (!isMainFrame && isSignInUrl(url)) contents.send('scrumly:sheet-needs-sign-in', url)
  }
  contents.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame) => needed(url, isMainFrame))
  // In case Google ever blocks the frame outright instead.
  contents.on('did-fail-load', (_e, _code, _description, url, isMainFrame) => needed(url, isMainFrame))
}

module.exports = { isSheetUrl, pickBrowser, openWindow, watch }
