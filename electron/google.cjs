'use strict'
/**
 * The Google connection, for showing private sheets inside Scrumly.
 *
 * Google will not sign anyone in inside a desktop app, so its editor cannot
 * show a private sheet here (sheets.cjs). Its API can, through the flow Google
 * prescribes for desktop apps: the consent page opens in the user's own
 * browser, they allow read-only access to their spreadsheets once, and the
 * browser hands a one-time code back to a listener on this machine
 * (127.0.0.1, PKCE). Scrumly never sees the password — only a token that can
 * read spreadsheets and nothing else.
 *
 * Kept in the main process, like Jira's token and for the same reasons. The
 * refresh token is encrypted with safeStorage (DPAPI on Windows) into
 * userData: never the database, the data file, a backup, or sync. The
 * renderer asks for a sheet's values by its id and gets values back; it never
 * holds a token.
 *
 * The OAuth client is the user's own, made once in Google Cloud. Google says a
 * desktop client's secret is not treated as a secret, but it goes in the same
 * encrypted file anyway.
 */
const { app, net, safeStorage, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

const FILE = 'google-credentials.bin'
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const REVOKE = 'https://oauth2.googleapis.com/revoke'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const READ_SHEETS = 'https://www.googleapis.com/auth/spreadsheets.readonly'
// Read-only sheets, plus which account it is, so the screen can say so.
const SCOPES = ['openid', 'email', READ_SHEETS]
const SHEET_ID = /^[A-Za-z0-9_-]{20,}$/
const CLIENT_ID = /^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/
// Long enough to make a Google Cloud project in another tab first, if need be.
const WAIT_MS = 10 * 60_000

function credentialsPath() {
  return path.join(app.getPath('userData'), FILE)
}

async function readCredentials() {
  try {
    return JSON.parse(safeStorage.decryptString(await fs.readFile(credentialsPath())))
  } catch {
    return null
  }
}

async function writeCredentials(creds) {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(credentialsPath(), safeStorage.encryptString(JSON.stringify(creds)))
}

/**
 * The OAuth client from what was pasted: the JSON file Google offers to
 * download, or the id and secret copied across one at a time.
 */
function parseClient(input) {
  let id = input && input.clientId
  let secret = input && input.clientSecret
  if (input && typeof input.json === 'string') {
    let parsed
    try { parsed = JSON.parse(input.json) } catch { throw new Error('That file is not the JSON Google offers to download') }
    if (parsed.web) throw new Error('That is a web client. Make one with Application type: Desktop app')
    const body = parsed.installed ?? parsed
    id = body.client_id
    secret = body.client_secret
  }
  id = String(id ?? '').trim()
  secret = String(secret ?? '').trim()
  if (!CLIENT_ID.test(id)) throw new Error('The client ID ends in .apps.googleusercontent.com')
  if (!secret) throw new Error('Paste the client secret as well')
  return { clientId: id, clientSecret: secret }
}

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

function authUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // A refresh token, every time, so access lasts past the first hour.
    access_type: 'offline',
    prompt: 'consent',
  })
  return `${AUTH}?${q}`
}

/** The account's address, from the id token Google hands over with the rest. */
function emailFrom(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email ?? null
  } catch {
    return null
  }
}

/** Says, in a sentence, what Google's consent page sent back instead of a code. */
function explainAuthError(error) {
  if (error === 'access_denied') return 'Google was not given access — Connect again and choose Allow'
  if (error === 'timeout') return 'Nothing came back from Google in ten minutes — Connect again when ready'
  if (error === 'cancelled') return 'Connecting was cancelled'
  return `Google did not connect (${error})`
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#14181D">
<h2 style="font-weight:600">${title}</h2><p>${body}</p></body>`

/**
 * Waits on 127.0.0.1 for Google to send the browser back with a code. Only an
 * answer carrying this attempt's own state is taken; anything else is turned
 * away without ending the wait.
 */
function listen(state) {
  return new Promise((ready, fail) => {
    let finish
    const result = new Promise((resolve) => { finish = resolve })
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(code
        ? PAGE('Scrumly is connected to Google', 'You can close this tab and go back to Scrumly.')
        : PAGE('Scrumly is not connected', 'Google was not given access. You can close this tab.'))
      done(code ? { code } : { error: url.searchParams.get('error') || 'no code' })
    })
    let settled = false
    const done = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      finish(outcome)
    }
    const timer = setTimeout(() => done({ error: 'timeout' }), WAIT_MS)
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      ready({ redirectUri: `http://127.0.0.1:${server.address().port}`, result, cancel: () => done({ error: 'cancelled' }) })
    })
  })
}

/** Never throws: every outcome comes back as { ok, … }, as Jira's do. */
async function tokenRequest(params) {
  try {
    const res = await net.fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, status: res.status, error: data.error, message: data.error_description || data.error || `Google answered ${res.status}` }
    }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, status: 0, message: `Could not reach Google: ${err && err.message ? err.message : err}` }
  }
}

let access = null // { token, expires } — in memory only, an hour at a time
let pending = null // the attempt waiting on the browser, if there is one

async function status() {
  const creds = await readCredentials()
  return {
    configured: Boolean(creds && creds.client),
    connected: Boolean(creds && creds.refreshToken),
    email: (creds && creds.email) || null,
    encryption: safeStorage.isEncryptionAvailable(),
  }
}

/**
 * Keeps the client when one is given, then opens Google's consent page in the
 * browser and waits for it to answer. `onConnected` raises Scrumly's window
 * again, since the user is looking at a browser tab by then.
 */
async function connect(input, onConnected) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, message: 'This computer cannot encrypt the access, so Scrumly will not keep it' }
  }
  const creds = (await readCredentials()) || {}
  let client = creds.client
  if (input) {
    try { client = parseClient(input) } catch (err) { return { ok: false, message: err.message } }
    // Kept before the browser opens, so a failed attempt need not be pasted again.
    await writeCredentials({ ...creds, client })
  }
  if (!client) return { ok: false, message: 'Paste the client ID and secret first' }

  if (pending) pending.cancel()
  const { verifier, challenge } = pkce()
  const state = crypto.randomBytes(16).toString('hex')
  let attempt
  try { attempt = await listen(state) } catch (err) { return { ok: false, message: `Could not wait for Google: ${err.message}` } }
  pending = attempt
  await shell.openExternal(authUrl({ clientId: client.clientId, redirectUri: attempt.redirectUri, challenge, state }))
  const outcome = await attempt.result
  if (pending === attempt) pending = null
  if (outcome.error) return { ok: false, message: explainAuthError(outcome.error) }

  const tokens = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: outcome.code,
    code_verifier: verifier,
    redirect_uri: attempt.redirectUri,
    grant_type: 'authorization_code',
  })
  if (!tokens.ok) return { ok: false, message: tokens.message }
  // Google's consent page lets each permission be unticked on its own.
  if (!String(tokens.data.scope || '').split(' ').includes(READ_SHEETS)) {
    return { ok: false, message: 'Google was not allowed to show your sheets — Connect again and tick "See all your Google Sheets spreadsheets"' }
  }
  if (!tokens.data.refresh_token) return { ok: false, message: 'Google did not hand over lasting access — Connect again' }

  const email = emailFrom(tokens.data.id_token)
  await writeCredentials({ client, refreshToken: tokens.data.refresh_token, email })
  access = { token: tokens.data.access_token, expires: Date.now() + (Number(tokens.data.expires_in) - 60) * 1000 }
  if (onConnected) onConnected()
  return { ok: true, email }
}

async function cancel() {
  if (pending) pending.cancel()
}

/** Forgets the access, and tells Google to as well. The client stays, so connecting again is one click. */
async function disconnect() {
  const creds = await readCredentials()
  access = null
  if (!creds) return
  if (creds.refreshToken) {
    try {
      await net.fetch(REVOKE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: creds.refreshToken }).toString(),
      })
    } catch { /* offline: the token is forgotten here regardless */ }
  }
  await writeCredentials({ client: creds.client })
}

/** An access token, refreshed when the last one has run out. */
async function accessToken() {
  if (access && access.expires > Date.now()) return { ok: true, token: access.token }
  const creds = await readCredentials()
  if (!creds || !creds.refreshToken) return { ok: false, status: 401, expired: true, message: 'Not connected to Google' }
  const r = await tokenRequest({
    client_id: creds.client.clientId,
    client_secret: creds.client.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  })
  if (!r.ok) {
    if (r.error === 'invalid_grant') {
      // Revoked, or a Testing project's seven days are up. Either way: connect again.
      await writeCredentials({ client: creds.client, email: creds.email })
      return { ok: false, status: 401, expired: true, message: 'Google access has run out — connect again' }
    }
    return r
  }
  access = { token: r.data.access_token, expires: Date.now() + (Number(r.data.expires_in) - 60) * 1000 }
  return { ok: true, token: access.token }
}

function explainApiError(status, body) {
  const err = (body && body.error) || {}
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(`${err.status} ${err.message}`)) {
    return 'The Google Sheets API is not turned on in your Google Cloud project — enable it there, then Reload'
  }
  if (status === 403) return 'The connected Google account cannot open this sheet'
  if (status === 404) return 'Google has no such sheet — check the link'
  if (status === 429) return 'Google asked Scrumly to slow down — it will try again shortly'
  return err.message ? `Google: ${err.message}` : `Google answered ${status}`
}

async function api(url, retried = false) {
  const t = await accessToken()
  if (!t.ok) return t
  try {
    const res = await net.fetch(url, { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' }, redirect: 'manual' })
    if (res.status === 401 && !retried) {
      access = null
      return api(url, true)
    }
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, message: explainApiError(res.status, body) }
    return { ok: true, status: res.status, data: body }
  } catch (err) {
    return { ok: false, status: 0, message: `Could not reach Google: ${err && err.message ? err.message : err}` }
  }
}

/**
 * One tab of a spreadsheet, as Google displays its values: the tab the link
 * named when `gid` is one of them, otherwise the first visible one.
 */
async function read(spreadsheetId, gid) {
  if (typeof spreadsheetId !== 'string' || !SHEET_ID.test(spreadsheetId)) {
    return { ok: false, status: 0, message: 'That is not a Google Sheet' }
  }
  const fields = 'properties.title,sheets.properties(sheetId,title,index,hidden,gridProperties.frozenRowCount)'
  const meta = await api(`${SHEETS}/${spreadsheetId}?fields=${encodeURIComponent(fields)}`)
  if (!meta.ok) return meta
  const tabs = ((meta.data && meta.data.sheets) || [])
    .map((s) => s.properties)
    .filter((p) => p && !p.hidden)
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ id: String(p.sheetId), title: p.title, frozenRows: (p.gridProperties && p.gridProperties.frozenRowCount) || 0 }))
  if (!tabs.length) return { ok: false, status: 0, message: 'That spreadsheet has no tabs to show' }
  const tab = tabs.find((t) => t.id === String(gid)) || tabs[0]
  // A tab name in A1 notation is quoted, with any quote inside it doubled.
  const range = `'${tab.title.replace(/'/g, "''")}'`
  const values = await api(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`)
  if (!values.ok) return values
  return {
    ok: true,
    status: 200,
    data: { title: meta.data.properties ? meta.data.properties.title : '', tabs, tab: tab.id, values: values.data.values || [] },
  }
}

module.exports = { status, connect, cancel, disconnect, read, parseClient, pkce, authUrl, emailFrom, explainApiError }
