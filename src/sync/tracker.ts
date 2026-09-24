import type { DBCoreMutateRequest, DBCoreTransaction, Middleware, DBCore } from 'dexie'
import { ALL_TABLE_NAMES, db } from '../db/schema'

/**
 * Remembers which rows changed on this device since they were last sent.
 *
 * It sits under the repo layer as Dexie middleware, so every write is seen
 * whichever function made it — a new repo function cannot forget to tell sync.
 * Only the table and key are kept, not the row: the push reads the row as it
 * is at that moment, and a row that is no longer there is sent as deleted.
 *
 * Kept in localStorage so a change made offline, or just before the tab was
 * closed, is still sent the next time the app opens.
 */

const DIRTY_KEY = 'scrumly-sync-dirty'
const ON_KEY = 'scrumly-sync-on'
const SEP = '\u0000'

const SYNCED = new Set<string>(ALL_TABLE_NAMES)

/** Row key -> a counter bumped on every change, so a push only clears what it actually sent. */
const dirty = new Map<string, number>()
let generation = 0
const listeners = new Set<() => void>()

/** Transactions the sync engine itself is writing in. Their writes came from the server. */
const fromServer = new WeakSet<object>()

let tracking = false
try {
  tracking = Boolean(localStorage.getItem(ON_KEY))
  for (const k of JSON.parse(localStorage.getItem(DIRTY_KEY) ?? '[]') as string[]) dirty.set(k, 0)
} catch {
  /* storage unavailable: nothing was pending */
}

let persistTimer: number | null = null
function persist() {
  if (persistTimer !== null) return
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    try { localStorage.setItem(DIRTY_KEY, JSON.stringify([...dirty.keys()])) } catch { /* full or blocked */ }
  }, 50)
}

export const rowKey = (table: string, id: string | number) => `${table}${SEP}${id}`
export function splitKey(key: string): [table: string, id: string] {
  const i = key.indexOf(SEP)
  return [key.slice(0, i), key.slice(i + 1)]
}

function mark(table: string, keys: readonly unknown[]) {
  if (!keys.length) return
  generation++
  for (const k of keys) dirty.set(rowKey(table, k as string | number), generation)
  persist()
  for (const fn of listeners) fn()
}

export const tracker = {
  /** On while signed in. Off, local edits stay local, as before sync existed. */
  setTracking(on: boolean) {
    tracking = on
    try {
      if (on) localStorage.setItem(ON_KEY, '1')
      else localStorage.removeItem(ON_KEY)
    } catch { /* storage unavailable */ }
  },
  isTracking: () => tracking,

  pending: () => [...dirty.entries()],
  count: () => dirty.size,
  has: (table: string, id: string | number) => dirty.has(rowKey(table, id)),

  /** Clears what was sent, unless it changed again while the push was in flight. */
  sent(entries: [string, number][]) {
    for (const [k, gen] of entries) if (dirty.get(k) === gen) dirty.delete(k)
    persist()
  },

  /** Every row in the database, for a device's first upload. */
  async markAll() {
    for (const name of ALL_TABLE_NAMES) {
      mark(name, await db.table(name).toCollection().primaryKeys())
    }
  },

  clear() {
    dirty.clear()
    persist()
  },

  onChange(fn: () => void) {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },

  /** Wrap a sync-engine transaction so the rows it writes are not sent straight back. */
  markFromServer(idbtrans: object) { fromServer.add(idbtrans) },
}

const middleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'scrumly-sync',
  create(down) {
    return {
      ...down,
      table(name) {
        const table = down.table(name)
        if (!SYNCED.has(name)) return table
        return {
          ...table,
          async mutate(req: DBCoreMutateRequest) {
            const record = tracking && !fromServer.has(req.trans as DBCoreTransaction & object)
            // A cleared table (a restore, or erasing everything) says only which
            // range went, so find the keys in it while they still exist.
            let doomed: unknown[] = []
            if (record && req.type === 'deleteRange') {
              const res = await table.query({
                trans: req.trans, values: false,
                query: { index: table.schema.primaryKey, range: req.range },
              })
              doomed = res.result
            }
            const res = await table.mutate(req)
            if (!record) return res
            if (req.type === 'deleteRange') mark(name, doomed)
            else if (req.type === 'delete') mark(name, req.keys)
            else {
              const keys = new Set<unknown>([...(res.results ?? []), ...(req.keys ?? []), ...(req.type === 'put' ? req.updates?.keys ?? [] : [])])
              mark(name, [...keys].filter((k) => k !== undefined))
            }
            return res
          },
        }
      },
    }
  },
}

db.use(middleware)
