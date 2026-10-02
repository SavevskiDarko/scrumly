'use strict'
/**
 * Signing in to Google, for the Sheets screen.
 *
 * A sheet that is not shared publicly opens in a frame only for someone Google
 * already knows, and Google's sign-in page refuses to be shown inside a frame.
 * So signing in gets a window of its own, on the app's own session: the
 * cookies Google leaves there are the ones every sheet's frame sends from then
 * on. It is Google's page talking to Google. Nothing typed into it passes
 * through Scrumly, and the account lives in those cookies and nowhere else —
 * not in the database, the data file, or sync.
 */
const { BrowserWindow, session, shell } = require('electron')

const DOCS = 'https://docs.google.com/'
const SIGN_IN = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(`${DOCS}spreadsheets/`)}`
// Signing in sets cookies on a few Google domains; signing out clears them all.
const GOOGLE_DOMAIN = /(^|\.)(google\.com|youtube\.com)$/

const isSignInUrl = (url) => typeof url === 'string' && url.startsWith('https://accounts.google.com/')

/**
 * Google turns away sign-ins from a browser that names itself as an embedded
 * framework, and Electron's default user agent does exactly that. Dropping its
 * own token and the app's leaves the Chromium it really is, by its Chrome
 * version. Set app-wide, so the frames and the sign-in window look the same to
 * Google.
 */
function plainUserAgent(ua, appName) {
  return ua
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S+`, 'i'), '')
}

async function status() {
  const cookies = await session.defaultSession.cookies.get({ domain: 'google.com' })
  // SID is there while signed in and gone once signed out; nothing else is read.
  return { signedIn: cookies.some((c) => c.name === 'SID' || c.name === '__Secure-3PSID') }
}

let open = null

/**
 * Opens Google's sign-in, or raises it if it is already up. Resolves once the
 * window closes — by itself, when Google sends it on to Docs, or by hand.
 */
function signIn(parent, startUrl) {
  if (open && !open.win.isDestroyed()) {
    open.win.focus()
    return open.done
  }
  const win = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    width: 500,
    height: 700,
    title: 'Sign in to Google',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const done = new Promise((resolve) => {
    win.on('closed', () => {
      open = null
      void status().then((s) => {
        if (parent && !parent.isDestroyed()) parent.webContents.send('scrumly:google-changed', s)
        resolve(s)
      })
    })
  })
  open = { win, done }

  // Help links and the like go to the real browser. Navigation within the
  // window is left alone: a Workspace account may sign in through its
  // company's own identity provider, wherever that is.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Reaching Docs means Google is done with the sign-in.
  win.webContents.on('did-navigate', (_e, url) => {
    if (url.startsWith(DOCS)) win.close()
  })
  void win.loadURL(isSignInUrl(startUrl) ? startUrl : SIGN_IN)
  return done
}

async function signOut(parent) {
  const ses = session.defaultSession
  for (const c of await ses.cookies.get({})) {
    const domain = (c.domain ?? '').replace(/^\./, '')
    if (!GOOGLE_DOMAIN.test(domain)) continue
    await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`, c.name)
  }
  const s = await status()
  if (parent && !parent.isDestroyed()) parent.webContents.send('scrumly:google-changed', s)
  return s
}

/**
 * Tells the renderer when a sheet's frame ends up on the sign-in page. Google
 * will not run sign-in inside a frame — it answers with a bare "401. That's an
 * error." page there — so the screen covers that and says what is actually
 * wrong. Landing is what counts, not passing through: Docs bounces its own
 * inner frames off the sign-in page and straight back all the time. The
 * sign-in address carries the sheet it would continue to, which says which
 * frame it was.
 */
function watch(contents) {
  const needed = (url, isMainFrame) => {
    if (!isMainFrame && isSignInUrl(url)) contents.send('scrumly:google-needed', url)
  }
  contents.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame) => needed(url, isMainFrame))
  // In case Google ever blocks the frame outright instead.
  contents.on('did-fail-load', (_e, _code, _description, url, isMainFrame) => needed(url, isMainFrame))
}

module.exports = { isSignInUrl, plainUserAgent, status, signIn, signOut, watch }
