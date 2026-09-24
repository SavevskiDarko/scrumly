'use strict'
/**
 * The durable copy of everything, as a plain JSON file on disk.
 *
 * Dexie/IndexedDB is still the live store the app reads and writes — nothing
 * about the repo layer changes. What changes is where the data really lives:
 * IndexedDB is keyed to an origin inside a browser profile, so a different
 * port, a different browser or a cleared cache all read as "no data yet". A
 * file does not have that problem. The renderer loads this file at startup
 * when its database is empty, and writes it back a couple of seconds after
 * anything changes.
 *
 * The file format is exactly what `backup.snapshot()` produces, so it imports
 * and exports by hand through the existing Backup panel as well.
 *
 * The naming and pruning of dated snapshots deliberately matches
 * src/repo/fileStore.ts — the browser folder feature writes the same layout, so
 * one can be pointed at the other's folder and neither is surprised. The two
 * copies exist because a CommonJS main process cannot import the TypeScript.
 *
 * A team kept on this computer only (src/repo/localOnly.ts) is left out of that
 * file, since the folder can be moved into OneDrive or a git repo. It gets the
 * same layout in a folder of its own under userData, which never moves — the
 * same reason the Jira token lives there.
 */
const { app } = require('electron')
const fs = require('node:fs/promises')

const path = require('node:path')

const LIVE_FILE = 'scrumly.json'
const HISTORY_DIR = 'history'
/** Roughly a month of daily snapshots. They are small and compress to nothing. */
const KEEP_HISTORY = 30
const CONFIG_FILE = 'config.json'
const LOCAL_DIR = 'this-computer-only'

/** One dated file per day, rewritten as the day goes on. */
function historyName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `scrumly-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
}

/**
 * Which dated snapshots to delete, oldest first. Names sort lexicographically
 * because the date is written biggest-unit-first, so no parsing is needed.
 */
function prunable(names, keep = KEEP_HISTORY) {
  const snapshots = names.filter((n) => /^scrumly-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()
  return snapshots.slice(0, Math.max(0, snapshots.length - keep))
}

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

function defaultDir() {
  return path.join(app.getPath('userData'), 'data')
}

function localDir() {
  return path.join(app.getPath('userData'), LOCAL_DIR)
}

/** The data folder must never be the local one, or one file would overwrite the other. */
function isLocalDir(dir) {
  const rel = path.relative(localDir(), path.resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Where the data lives. Read from disk on every call rather than cached: the
 * folder can be changed from Settings, and a stale cache would quietly keep
 * writing to the old one.
 */
async function dataDir() {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'))
    if (typeof raw.dataDir === 'string' && raw.dataDir) return raw.dataDir
  } catch {
    /* no config yet, or unreadable — the default is always valid */
  }
  return defaultDir()
}

async function setDataDir(dir) {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify({ dataDir: dir }, null, 2), 'utf8')
}

/**
 * Write to a temporary file and rename over the target. Rename is atomic, so a
 * crash or a power cut mid-write cannot leave a half-written scrumly.json —
 * the old one stays intact until the new one is complete. Same guarantee the
 * browser's createWritable() gives the File System Access path.
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

async function readFrom(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, LIVE_FILE), 'utf8'))
  } catch {
    return null
  }
}

async function read() {
  return readFrom(await dataDir())
}

async function readLocal() {
  return readFrom(localDir())
}

/** Writes the live file, then today's dated snapshot, then prunes old ones. */
async function writeInto(dir, snapshot, now = new Date()) {
  const text = JSON.stringify(snapshot, null, 2)

  await fs.mkdir(dir, { recursive: true })
  await writeAtomic(path.join(dir, LIVE_FILE), text)

  const history = path.join(dir, HISTORY_DIR)
  await fs.mkdir(history, { recursive: true })
  await writeAtomic(path.join(history, historyName(now)), text)

  const names = await fs.readdir(history).catch(() => [])
  for (const stale of prunable(names)) {
    await fs.rm(path.join(history, stale), { force: true }).catch(() => {})
  }

  return { dir, file: path.join(dir, LIVE_FILE), bytes: Buffer.byteLength(text), at: Date.now() }
}

async function write(snapshot, now = new Date()) {
  return writeInto(await dataDir(), snapshot, now)
}

/**
 * Only once there is something to keep: until a team is kept here, no folder
 * at all rather than an empty file in every install. After that it is written
 * even when empty, so a team let go again cannot come back from a stale copy.
 */
async function writeLocal(snapshot, now = new Date()) {
  const rows = Object.values(snapshot.tables ?? {}).reduce((n, t) => n + (Array.isArray(t) ? t.length : 0), 0)
  if (rows === 0 && !(await fs.stat(path.join(localDir(), LIVE_FILE)).catch(() => null))) return null
  return writeInto(localDir(), snapshot, now)
}

/** What Settings shows: where the file is, and whether anything is in it yet. */
async function info() {
  const dir = await dataDir()
  const file = path.join(dir, LIVE_FILE)
  const where = { dir, file, isDefault: dir === defaultDir(), localDir: localDir() }
  try {
    const stat = await fs.stat(file)
    return { ...where, exists: true, bytes: stat.size, modifiedAt: stat.mtimeMs }
  } catch {
    return { ...where, exists: false, bytes: 0, modifiedAt: null }
  }
}

module.exports = {
  LIVE_FILE, HISTORY_DIR, KEEP_HISTORY, historyName, prunable, dataDir, defaultDir, localDir, isLocalDir, setDataDir,
  read, write, readLocal, writeLocal, info,
}
