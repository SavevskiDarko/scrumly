import { ALL_TABLE_NAMES, SCHEMA_VERSION, db } from '../db/schema'
import { clearExcept, currentScope, scopeOf } from './localOnly'

/** Written into every export. Older files say 'cadence'; those still restore. */
export const APP_ID = 'scrumly'
const LEGACY_APP_IDS = ['cadence']

export interface Snapshot {
  app: string
  schemaVersion: number
  exportedAt: string
  tables: Record<string, unknown[]>
}

function wrap(tables: Record<string, unknown[]>): Snapshot {
  return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tables }
}

function readable(raw: unknown): { snap: Snapshot } | { error: string } {
  const snap = raw as Snapshot
  const known = snap && (snap.app === APP_ID || LEGACY_APP_IDS.includes(snap.app))
  if (!known || !snap.tables) return { error: 'That file is not a Scrumly backup.' }
  if (snap.schemaVersion > SCHEMA_VERSION) {
    return { error: `That backup was written by a newer version (schema ${snap.schemaVersion}). Update Scrumly first.` }
  }
  return { snap }
}

export const backup = {
  /**
   * Plain JSON. Readable without this app, and the route your data takes
   * anywhere else — so it never holds what is kept on this computer only.
   */
  async snapshot(): Promise<Snapshot> {
    return (await backup.split()).main
  },

  /**
   * One read, cut in two: `main`, everything that may leave this computer, and
   * `local`, what is kept on it only (src/repo/localOnly.ts). The desktop app
   * writes each to a file of its own; everywhere else only `main` is used.
   */
  async split(): Promise<{ main: Snapshot; local: Snapshot }> {
    const tables: Record<string, unknown[]> = {}
    for (const name of ALL_TABLE_NAMES) tables[name] = await db.table(name).toArray()
    const keep = scopeOf(tables)
    const main: Record<string, unknown[]> = {}
    const local: Record<string, unknown[]> = {}
    for (const name of ALL_TABLE_NAMES) {
      const here = (row: unknown) => keep.has(name, (row as { id: string | number }).id)
      main[name] = keep.empty ? tables[name] : tables[name].filter((row) => !here(row))
      local[name] = keep.empty ? [] : tables[name].filter(here)
    }
    return { main: wrap(main), local: wrap(local) }
  },

  filename(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${APP_ID}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
  },

  /**
   * Replaces everything with a backup. A backup never holds what is kept on
   * this computer only, so that is left exactly as it is — unless `local`, the
   * desktop app's own file of it, is loaded alongside, and replaces it too.
   */
  async restore(raw: unknown, local?: unknown): Promise<{ ok: boolean; error?: string; counts?: Record<string, number> }> {
    const main = readable(raw)
    if ('error' in main) return { ok: false, error: main.error }
    const here = local === undefined ? null : readable(local)
    if (here && 'error' in here) return { ok: false, error: here.error }

    const counts: Record<string, number> = {}
    await db.transaction('rw', ALL_TABLE_NAMES.map((n) => db.table(n)), async () => {
      // Worked out inside the transaction, so it is exactly what is kept.
      const keep = here ? null : await currentScope()
      for (const name of ALL_TABLE_NAMES) {
        if (keep) await clearExcept(name, keep)
        else await db.table(name).clear()
        // What stays here wins over an older copy of it in the backup.
        const rows = [
          ...(main.snap.tables[name] ?? []).filter((row) => !keep?.has(name, (row as { id: string | number }).id)),
          ...(here?.snap.tables[name] ?? []),
        ]
        if (rows.length) await db.table(name).bulkPut(rows)
        counts[name] = rows.length
      }
    })
    return { ok: true, counts }
  },

  async wipe() {
    const stores = ALL_TABLE_NAMES.map((n) => (db as never as Record<string, unknown>)[n])
    await db.transaction('rw', stores as never, async () => {
      for (const name of ALL_TABLE_NAMES) {
        await (db as never as Record<string, { clear(): Promise<void> }>)[name].clear()
      }
    })
  },
}

/**
 * Hands the viewer a file. Uses the host's download capability when the app is
 * running inside claude.ai (where an anchor download is inert), and a plain
 * anchor everywhere else. Returns false if neither worked, so the caller can
 * fall back to showing the JSON for copying.
 */
export async function saveBinaryFile(filename: string, blob: Blob): Promise<boolean> {
  const host = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude
  if (host?.use) {
    try {
      const dl = (await host.use('downloads')) as { save?: (a: { filename: string; data: string }) => Promise<unknown> } | null
      if (dl?.save) {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => reject(new Error('read failed'))
          r.readAsDataURL(blob)
        })
        await dl.save({ filename, data: dataUrl })
        return true
      }
    } catch {
      /* fall through to the anchor */
    }
  }
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  } catch {
    return false
  }
}

export async function saveTextFile(filename: string, text: string): Promise<boolean> {
  const host = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude
  if (host?.use) {
    try {
      const dl = (await host.use('downloads')) as { save?: (a: { filename: string; data: string }) => Promise<unknown> } | null
      if (dl?.save) {
        await dl.save({ filename, data: text })
        return true
      }
    } catch {
      /* fall through to the anchor */
    }
  }
  try {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  } catch {
    return false
  }
}
