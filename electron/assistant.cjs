'use strict'
/**
 * The assistant's line to Claude, kept in the main process for the same
 * reasons as Jira's (jira.cjs):
 *
 *   - The Anthropic API key is encrypted with safeStorage (DPAPI on Windows)
 *     into userData. Never the database, the data folder, a backup or sync,
 *     and it never goes back to the renderer.
 *   - The renderer decides what to say; this file decides who it is said to
 *     and how. The model, thinking and limits are fixed here, so nothing in
 *     the renderer can turn the key into anything else.
 *
 * The renderer runs the conversation itself — it holds the database, so it
 * reads the board and applies whatever the user approves — and hands each
 * request over whole. Text streams back as it is written; the finished
 * message is the result.
 */
const { app, net, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const {
  Anthropic, APIConnectionError, APIError, APIUserAbortError, AuthenticationError, BadRequestError,
  InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} = require('@anthropic-ai/sdk')

const FILE = 'assistant-key.bin'
const MODEL = 'claude-opus-5-5'
/** Room for a long answer with thinking. Streamed, so a high ceiling costs nothing until it is used. */
const MAX_TOKENS = 32000
/** Lets Anthropic re-run a request on another model if this one declines it, rather than the user just being refused. */
const BETAS = ['server-side-fallback-2026-07-01']

/** Requests still streaming, by the id the renderer gave them, so Stop can reach them. */
const running = new Map()

function keyPath() {
  return path.join(app.getPath('userData'), FILE)
}

/** The key, and the workspace to name with it when the key belongs to none. */
async function readCredentials() {
  try {
    const text = safeStorage.decryptString(await fs.readFile(keyPath()))
    if (!text) return null
    // 0.3.13 stored the bare key.
    if (!text.startsWith('{')) return { apiKey: text, workspaceId: null }
    const creds = JSON.parse(text)
    return creds && creds.apiKey ? { apiKey: creds.apiKey, workspaceId: creds.workspaceId || null } : null
  } catch {
    return null
  }
}

/**
 * Electron's own fetch, so requests go through the system proxy the way the
 * rest of Windows does — the difference between working and not on a company
 * laptop.
 */
function client({ apiKey, workspaceId }) {
  return new Anthropic({
    apiKey,
    // A key made outside any workspace has to say which one to use on every
    // request; one made inside a workspace must not.
    defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
    fetch: (url, init) => net.fetch(url, init),
  })
}

/** What Anthropic said, without the status code and raw JSON wrapped round it. */
function said(err) {
  const body = err && err.error && err.error.error
  return (body && typeof body.message === 'string' && body.message) || (err && err.message) || String(err)
}

/** Anthropic refusing a key that belongs to no workspace because none was named. */
function needsWorkspace(err) {
  return err instanceof BadRequestError && /anthropic-workspace-id|scoped to a workspace/i.test(said(err))
}

/**
 * Every outcome as a sentence. IPC turns thrown errors into unhelpful strings,
 * so nothing here throws across it.
 */
function explain(err) {
  if (err instanceof APIUserAbortError) return { error: 'Stopped', aborted: true }
  if (err instanceof AuthenticationError) return { error: 'Anthropic no longer accepts the API key — connect it again in Settings' }
  if (err instanceof PermissionDeniedError) return { error: 'That API key is not allowed to use Claude Opus 5.5' }
  if (err instanceof NotFoundError) return { error: 'Claude Opus 5.5 is not available to that API key' }
  if (err instanceof RateLimitError) return { error: 'Anthropic asked Scrumly to slow down — try again in a minute' }
  if (err instanceof InternalServerError) return { error: 'Claude is busy or having trouble — try again in a moment' }
  if (err instanceof APIConnectionError) return { error: 'Could not reach Anthropic — check the connection' }
  if (err instanceof APIError) return { error: `Anthropic answered ${err.status ?? 'with an error'}: ${said(err)}` }
  // Not an answer from the API: a reply that could not be read, which asking
  // again usually fixes.
  return { error: 'Claude\'s reply could not be read', retry: true }
}

async function status() {
  const creds = await readCredentials()
  return {
    connected: Boolean(creds),
    encryption: safeStorage.isEncryptionAvailable(),
    model: MODEL,
    workspace: creds ? creds.workspaceId : null,
  }
}

/** Checks the key with Anthropic before keeping it, so a typo shows up here and not on the first question. */
async function connect(input) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, message: 'This computer cannot encrypt the key, so Scrumly will not store it' }
  }
  const apiKey = String((input && input.apiKey) || '').trim()
  const workspaceId = String((input && input.workspaceId) || '').trim() || null
  if (!apiKey) return { ok: false, message: 'Paste the API key' }
  const creds = { apiKey, workspaceId }
  try {
    await client(creds).models.retrieve(MODEL)
  } catch (err) {
    if (needsWorkspace(err)) {
      return {
        ok: false,
        needsWorkspace: true,
        message: workspaceId
          ? `Anthropic would not use that workspace with this key: ${said(err)}`
          : 'This key is not tied to a workspace, so Anthropic needs to be told which one to use',
      }
    }
    return { ok: false, message: err instanceof AuthenticationError ? 'Anthropic did not accept that key' : explain(err).error }
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(keyPath(), safeStorage.encryptString(JSON.stringify(creds)))
  return { ok: true }
}

async function disconnect() {
  for (const stream of running.values()) stream.abort()
  await fs.rm(keyPath(), { force: true })
}

/**
 * One turn of the conversation. Text goes to `onText` as it arrives; the
 * result is the whole message, or a sentence saying why there is none.
 */
async function send(requestId, request, onText) {
  const creds = await readCredentials()
  if (!creds) return { ok: false, error: 'Connect an Anthropic API key in Settings first' }
  if (!request || typeof request.system !== 'string' || !Array.isArray(request.messages) || !Array.isArray(request.tools)) {
    return { ok: false, error: 'Scrumly sent the assistant a malformed request' }
  }

  const stream = client(creds).beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    // Caches everything up to the newest message, so each turn pays full
    // price only for what is new since the last one.
    cache_control: { type: 'ephemeral' },
    fallbacks: 'default',
    betas: BETAS,
    system: request.system,
    tools: request.tools,
    messages: request.messages,
  })
  running.set(requestId, stream)
  stream.on('text', (delta) => onText(delta))
  try {
    return { ok: true, reply: await stream.finalMessage() }
  } catch (err) {
    return { ok: false, ...explain(err) }
  } finally {
    running.delete(requestId)
  }
}

function cancel(requestId) {
  running.get(requestId)?.abort()
}

module.exports = { status, connect, disconnect, send, cancel, MODEL }
