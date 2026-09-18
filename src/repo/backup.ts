import { ALL_TABLE_NAMES, SCHEMA_VERSION, db } from '../db/schema'

/** Written into every export. Older files say 'cadence'; those still restore. */
export const APP_ID = 'scrumly'
const LEGACY_APP_IDS = ['cadence']

export interface Snapshot {
  app: string
  schemaVersion: number
  exportedAt: string
  tables: Record<string, unknown[]>
}

export const backup = {
  /** Plain JSON. Readable without this app, and the route your data takes anywhere else. */
  async snapshot(): Promise<Snapshot> {
    const tables: Record<string, unknown[]> = {}
    for (const name of ALL_TABLE_NAMES) {
      tables[name] = await (db as never as Record<string, { toArray(): Promise<unknown[]> }>)[name].toArray()
    }
    return {
      app: APP_ID,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
    }
  },

  filename(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${APP_ID}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
  },

  async restore(raw: unknown): Promise<{ ok: boolean; error?: string; counts?: Record<string, number> }> {
    const snap = raw as Snapshot
    const known = snap && (snap.app === APP_ID || LEGACY_APP_IDS.includes(snap.app))
    if (!known || !snap.tables) {
      return { ok: false, error: 'That file is not a Scrumly backup.' }
    }
    if (snap.schemaVersion > SCHEMA_VERSION) {
      return { ok: false, error: `That backup was written by a newer version (schema ${snap.schemaVersion}). Update Scrumly first.` }
    }

    const counts: Record<string, number> = {}
    const stores = ALL_TABLE_NAMES.map((n) => (db as never as Record<string, unknown>)[n])
    await db.transaction('rw', stores as never, async () => {
      for (const name of ALL_TABLE_NAMES) {
        const table = (db as never as Record<string, { clear(): Promise<void>; bulkAdd(rows: unknown[]): Promise<unknown> }>)[name]
        await table.clear()
        const rows = snap.tables[name] ?? []
        if (rows.length) await table.bulkAdd(rows)
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
