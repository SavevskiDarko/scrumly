import { ALL_TABLE_NAMES, db } from '../db/schema'
import type { ID } from '../db/types'
import { clearExcept, currentScope } from '../repo/localOnly'
import { teams } from '../repo/teams'
import { rowKey, splitKey, tracker } from './tracker'

/*
 * The database's side of sync: which rows go out, and how the ones that come
 * in are written. Nothing here touches the network, so it runs, and is tested,
 * without a server.
 *
 * It is also where "kept on this computer only" holds for sync, one rule each
 * way. Such a row always goes out as deleted, which is how the synced copy and
 * every other device lose it. And nothing that comes in touches it: the cloud
 * never has the last word on a row it should not have.
 */

export interface RemoteRow {
  user_id: string
  tbl: string
  id: string
  data: Record<string, unknown> | null
  deleted: boolean
  device: string | null
  seq: number
}

export const SYNCED = new Set<string>(ALL_TABLE_NAMES)

/** Settings is the one table keyed by a number. */
const localKey = (tbl: string, id: string): string | number => (tbl === 'settings' ? Number(id) : id)

/** jsonb does not keep key order, so compare rows independently of it. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export interface Outgoing {
  entry: [string, number]
  tbl: string
  id: string
  /** Null means send it as deleted. */
  data: Record<string, unknown> | null
}

/** Each pending row as it is now. Gone means deleted, and so does kept on this computer. */
export async function readOutgoing(entries: [string, number][]): Promise<Outgoing[]> {
  const byTable = new Map<string, [string, number][]>()
  for (const e of entries) {
    const [tbl] = splitKey(e[0])
    if (!SYNCED.has(tbl)) continue
    byTable.set(tbl, [...(byTable.get(tbl) ?? []), e])
  }
  const out: Outgoing[] = []
  // One read, so the rows and what decides whether they stay here agree.
  await db.transaction('r', ALL_TABLE_NAMES.map((n) => db.table(n)), async () => {
    const keep = await currentScope()
    for (const [tbl, list] of byTable) {
      const rows = await db.table(tbl).bulkGet(list.map(([k]) => localKey(tbl, splitKey(k)[1])))
      list.forEach((entry, i) => {
        const id = splitKey(entry[0])[1]
        const data = keep.has(tbl, id) ? null : (rows[i] as Record<string, unknown> | undefined) ?? null
        out.push({ entry, tbl, id, data })
      })
    }
  })
  return out
}

/**
 * Writes incoming rows. `replace` empties the database first, for a device
 * taking the cloud's copy — all but what is kept on this computer, which the
 * cloud does not have. The transaction is marked so the tracker does not send
 * these rows straight back.
 */
export async function applyIncoming(rows: RemoteRow[], replace: boolean): Promise<void> {
  // Only the newest version of each row matters.
  const latest = new Map<string, RemoteRow>()
  for (const r of rows) if (SYNCED.has(r.tbl)) latest.set(rowKey(r.tbl, r.id), r)
  if (!latest.size && !replace) return

  const erase: [string, string][] = []
  await db.transaction('rw', ALL_TABLE_NAMES.map((n) => db.table(n)), async (tx) => {
    tracker.markFromServer(tx.idbtrans)
    // Judged by the rows arriving as well as the ones here: a task made
    // elsewhere for a team this computer keeps belongs to that team too.
    const arriving: Record<string, unknown[]> = {}
    for (const r of latest.values()) if (!r.deleted && r.data) (arriving[r.tbl] ??= []).push(r.data)
    const keep = await currentScope(arriving)
    if (replace) for (const name of ALL_TABLE_NAMES) await clearExcept(name, keep)

    const byTable = new Map<string, RemoteRow[]>()
    for (const r of latest.values()) {
      if (keep.has(r.tbl, r.id)) {
        // A deletion is usually this device's own, coming back. A live copy
        // is left over from before, or from a device that had not heard yet,
        // and is deleted from the cloud in its turn.
        if (!r.deleted && r.data) erase.push([r.tbl, r.id])
        continue
      }
      byTable.set(r.tbl, [...(byTable.get(r.tbl) ?? []), r])
    }
    for (const [tbl, list] of byTable) {
      const table = db.table(tbl)
      // Unsent changes here win: they are about to be sent.
      const incoming = list.filter((r) => !tracker.has(tbl, r.id))
      if (!incoming.length) continue
      const keys = incoming.map((r) => localKey(tbl, r.id))
      const current = replace ? [] : await table.bulkGet(keys)
      const puts: unknown[] = []
      const dels: (string | number)[] = []
      incoming.forEach((r, i) => {
        const have = current[i]
        if (r.deleted || !r.data) { if (replace || have !== undefined) dels.push(keys[i]) }
        else if (replace || have === undefined || stable(have) !== stable(r.data)) puts.push(r.data)
      })
      if (puts.length) await table.bulkPut(puts)
      if (dels.length && !replace) await table.bulkDelete(dels)
    }
  })
  if (erase.length) tracker.queue(erase)
}

/**
 * Keeps a team on this computer only, or lets it travel again. Whatever that
 * moves across the line is queued for the cloud: as a deletion when it stays
 * here now, which clears it from the synced copy and every other device, and
 * as itself when it no longer does, so it comes back.
 */
export async function keepOnThisComputer(teamId: ID, on: boolean): Promise<void> {
  const before = await currentScope()
  await teams.setLocalOnly(teamId, on)
  const after = await currentScope()
  tracker.queue([
    ...before.keys().filter(([t, id]) => !after.has(t, id)),
    ...after.keys().filter(([t, id]) => !before.has(t, id)),
  ])
}
