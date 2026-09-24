'use strict'
/**
 * The Jira connection, kept entirely in the main process.
 *
 * The renderer never sees the token. It asks for Jira data by API path and gets
 * JSON back; the credentials are read from disk here, attached here, and sent
 * only to the one site they were entered for. Three reasons it lives here and
 * nowhere else:
 *
 *   - Jira's REST API does not answer cross-origin requests from a web page, so
 *     the renderer could not make these calls itself anyway.
 *   - Everything in IndexedDB is synced to Supabase, exported in backups, and
 *     can be committed with `npm run save`. A token there would travel with it.
 *   - The data folder can be moved from Settings — into a synced drive or a git
 *     repo — so the credentials go in userData instead, which never moves.
 *
 * The file is encrypted with safeStorage, which on Windows is DPAPI: readable
 * only by this Windows user on this machine.
 */
const { app, net, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

const FILE = 'jira-credentials.bin'

/** Read-only, and only the two APIs the import uses. */
const ALLOWED_PATHS = [/^\/rest\/agile\/1\.0\//, /^\/rest\/api\/2\//]

function credentialsPath() {
  return path.join(app.getPath('userData'), FILE)
}

async function readCredentials() {
  try {
    const raw = await fs.readFile(credentialsPath())
    return JSON.parse(safeStorage.decryptString(raw))
  } catch {
    return null
  }
}

async function writeCredentials(creds) {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(credentialsPath(), safeStorage.encryptString(JSON.stringify(creds)))
}

/**
 * "acme.atlassian.net", "https://acme.atlassian.net/" and
 * "https://jira.acme.com/jira" all become a base URL with no trailing slash.
 * Server installs can sit under a context path, so the path is kept.
 *
 * Plain http is refused except on this machine: it would send the token in
 * the clear to anything between here and the server.
 */
function normaliseSite(input) {
  const text = String(input || '').trim()
  if (!text) throw new Error('Enter your Jira address')
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Jira has to be reached over https')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Jira Cloud takes email + API token; Server and Data Center take a personal access token. */
function authorization(creds) {
  return creds.email
    ? `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`
    : `Bearer ${creds.token}`
}

function explain(status) {
  if (status === 401) return 'Jira did not accept those details — check the email and token'
  if (status === 403) return 'That account is not allowed to see this in Jira'
  if (status === 404) return 'Jira has no such thing (404)'
  if (status === 429) return 'Jira asked Scrumly to slow down — it will try again on the next pull'
  return `Jira answered ${status}`
}

/**
 * One GET. Never throws: IPC turns exceptions into unhelpful strings, so every
 * outcome comes back as { ok, status, data | message }.
 *
 * Redirects are refused rather than followed. A Jira behind single sign-on
 * redirects an unauthenticated API call to a login page, and following it would
 * mean handing the Authorization header to wherever the redirect pointed.
 */
async function get(creds, apiPath) {
  if (typeof apiPath !== 'string' || !ALLOWED_PATHS.some((re) => re.test(apiPath))) {
    return { ok: false, status: 0, message: 'Scrumly only reads Jira\'s issue and board APIs' }
  }
  try {
    const res = await net.fetch(creds.site + apiPath, {
      headers: { Authorization: authorization(creds), Accept: 'application/json' },
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, message: 'Jira sent Scrumly to a login page — the token was not accepted' }
    }
    if (!res.ok) return { ok: false, status: res.status, message: explain(res.status) }
    const text = await res.text()
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) }
    } catch {
      return { ok: false, status: res.status, message: 'Jira answered with a web page instead of data — check the address' }
    }
  } catch (err) {
    return { ok: false, status: 0, message: `Could not reach Jira: ${err && err.message ? err.message : err}` }
  }
}

async function status() {
  const creds = await readCredentials()
  return {
    connected: Boolean(creds),
    site: creds ? creds.site : null,
    user: creds ? creds.user : null,
    cloud: creds ? Boolean(creds.email) : null,
    encryption: safeStorage.isEncryptionAvailable(),
  }
}

/** Checks the details against Jira before keeping them, so a typo is caught here and not on the first pull. */
async function connect(input) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, message: 'This computer cannot encrypt the token, so Scrumly will not store it' }
  }
  let site
  try {
    site = normaliseSite(input && input.site)
  } catch (err) {
    return { ok: false, message: err.message }
  }
  const token = String((input && input.token) || '').trim()
  const email = String((input && input.email) || '').trim()
  if (!token) return { ok: false, message: 'Paste the API token' }

  const creds = { site, email, token, user: null }
  const me = await get(creds, '/rest/api/2/myself')
  if (!me.ok) return { ok: false, message: me.message }
  creds.user = me.data.displayName || me.data.emailAddress || me.data.name || 'you'
  await writeCredentials(creds)
  return { ok: true, site, user: creds.user }
}

async function disconnect() {
  await fs.rm(credentialsPath(), { force: true })
}

async function request(apiPath) {
  const creds = await readCredentials()
  if (!creds) return { ok: false, status: 0, message: 'Not connected to Jira' }
  return get(creds, apiPath)
}

module.exports = { status, connect, disconnect, request, normaliseSite }
