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
 */
const { app } = require('electron')
const fs = require('node:fs/promises')

const path = require('node:path')

const LIVE_FILE = 'scrumly.json'
const HISTORY_DIR = 'history'
/** Roughly a month of daily snapshots. They are small and compress to nothing. */
const KEEP_HISTORY = 30
const CONFIG_FILE = 'config.json'

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

async function liveFile() {
  return path.join(await dataDir(), LIVE_FILE)
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

async function read() {
  try {
    return JSON.parse(await fs.readFile(await liveFile(), 'utf8'))
  } catch {
    return null
  }
}

/** Writes the live file, then today's dated snapshot, then prunes old ones. */
async function write(snapshot, now = new Date()) {
  const dir = await dataDir()
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

/** What Settings shows: where the file is, and whether anything is in it yet. */
async function info() {
  const dir = await dataDir()
  const file = path.join(dir, LIVE_FILE)
  try {
    const stat = await fs.stat(file)
    return { dir, file, exists: true, bytes: stat.size, modifiedAt: stat.mtimeMs, isDefault: dir === defaultDir() }
  } catch {
    return { dir, file, exists: false, bytes: 0, modifiedAt: null, isDefault: dir === defaultDir() }
  }
}

module.exports = { LIVE_FILE, HISTORY_DIR, KEEP_HISTORY, historyName, prunable, dataDir, defaultDir, setDataDir, read, write, info }
