import type { Snapshot } from './backup'

/**
 * Mirrors the database to a real folder on disk.
 *
 * IndexedDB is still the live store — nothing about how the app reads or writes
 * changes. This keeps a plain JSON copy in a folder you choose, rewritten a few
 * seconds after anything changes, plus one dated snapshot per day. Put that
 * folder in OneDrive, Dropbox or a git repo and clearing site data, reinstalling
 * the browser or losing the machine stops being the end of your data.
 *
 * The directory handle deliberately lives in its own IndexedDB database rather
 * than in the app's. It must never end up inside a backup export — a handle is
 * meaningless in another browser, and it would have to be stripped on restore.
 */

type Permission = 'granted' | 'denied' | 'prompt'

/** The picker and the permission methods are not in lib.dom yet. */
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<Permission>
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<Permission>
}
interface DirListing {
  keys(): AsyncIterableIterator<string>
}
declare global {
  interface Window {
    showDirectoryPicker?: (o?: {
      mode?: 'read' | 'readwrite'
      id?: string
      startIn?: string
    }) => Promise<FileSystemDirectoryHandle>
  }
}

export const LIVE_FILE = 'scrumly.json'
export const HISTORY_DIR = 'history'
/** Roughly a month of daily snapshots. They are small and compress to nothing. */
export const KEEP_HISTORY = 30

const HANDLE_DB = 'scrumly-local'
const HANDLE_STORE = 'handles'
const HANDLE_KEY = 'backupDir'

/** One dated file per day, rewritten as the day goes on. */
export function historyName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `scrumly-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
}

/**
 * Which dated snapshots to delete, oldest first. Names sort lexicographically
 * because the date is written biggest-unit-first, so no parsing is needed.
 */
export function prunable(names: string[], keep = KEEP_HISTORY): string[] {
  const snapshots = names.filter((n) => /^scrumly-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()
  return snapshots.slice(0, Math.max(0, snapshots.length - keep))
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) req.result.createObjectStore(HANDLE_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openHandleDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(HANDLE_STORE, mode).objectStore(HANDLE_STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function writeJson(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const file = await dir.getFileHandle(name, { create: true })
  // close() commits; the browser writes through a swap file, so a crash
  // mid-write cannot leave a half-written scrumly.json behind.
  const stream = await file.createWritable()
  await stream.write(text)
  await stream.close()
}

export const fileStore = {
  /** Chrome and Edge have the File System Access API; Firefox and Safari do not. */
  supported: () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function',

  async saved(): Promise<DirHandle | null> {
    try {
      return (await idb<DirHandle | undefined>('readonly', (s) => s.get(HANDLE_KEY))) ?? null
    } catch {
      return null
    }
  },

  async remember(handle: FileSystemDirectoryHandle) {
    await idb('readwrite', (s) => s.put(handle, HANDLE_KEY))
  },

  async forget() {
    await idb('readwrite', (s) => s.delete(HANDLE_KEY))
  },

  /** Must be called from a click: browsers refuse the picker without a gesture. */
  async choose(): Promise<DirHandle | null> {
    if (!window.showDirectoryPicker) return null
    const handle = (await window.showDirectoryPicker({
      mode: 'readwrite', id: 'scrumly-backup', startIn: 'documents',
    })) as DirHandle
    await fileStore.remember(handle)
    return handle
  },

  /**
   * Permission does not survive a browser restart on its own. `request` needs a
   * user gesture, so startup asks with request=false and the Settings button
   * asks with request=true.
   */
  async permission(handle: DirHandle, request = false): Promise<Permission> {
    const opts = { mode: 'readwrite' as const }
    try {
      const current = (await handle.queryPermission?.(opts)) ?? 'granted'
      if (current === 'granted' || !request) return current
      return (await handle.requestPermission?.(opts)) ?? 'denied'
    } catch {
      return 'denied'
    }
  },

  /** Writes the live file, and today's dated snapshot, then prunes old ones. */
  async write(handle: FileSystemDirectoryHandle, snapshot: Snapshot, now = new Date()) {
    const text = JSON.stringify(snapshot, null, 2)
    await writeJson(handle, LIVE_FILE, text)

    const history = await handle.getDirectoryHandle(HISTORY_DIR, { create: true })
    await writeJson(history, historyName(now), text)

    const names: string[] = []
    for await (const name of (history as unknown as DirListing).keys()) names.push(name)
    for (const stale of prunable(names)) {
      await history.removeEntry(stale).catch(() => {})
    }
    return { bytes: text.length, at: Date.now() }
  },

  /** The live file, for restoring after the browser has been wiped. */
  async readLive(handle: FileSystemDirectoryHandle): Promise<unknown | null> {
    try {
      const file = await handle.getFileHandle(LIVE_FILE)
      return JSON.parse(await (await file.getFile()).text())
    } catch {
      return null
    }
  },
}

/**
 * Asks the browser not to evict the database when the disk gets tight. Free,
 * and orthogonal to the folder: it protects against silent eviction, while the
 * folder protects against everything else.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
