import { db } from '../db/schema'
import type { Status } from '../db/types'
import { newId } from './ids'

export const DEFAULT_STATUSES: Omit<Status, 'id'>[] = [
  { name: 'Backlog',     order: 0, countsAsActive: false, isDone: false, wipLimit: null, stuckAfterDays: null },
  { name: 'To do',       order: 1, countsAsActive: false, isDone: false, wipLimit: null, stuckAfterDays: 7 },
  { name: 'In progress', order: 2, countsAsActive: true,  isDone: false, wipLimit: null, stuckAfterDays: 3 },
  { name: 'Code review', order: 3, countsAsActive: true,  isDone: false, wipLimit: null, stuckAfterDays: 2 },
  { name: 'QA',          order: 4, countsAsActive: true,  isDone: false, wipLimit: null, stuckAfterDays: 3 },
  { name: 'Done',        order: 5, countsAsActive: false, isDone: true,  wipLimit: null, stuckAfterDays: null },
]

export const statuses = {
  list: () => db.statuses.orderBy('order').toArray(),

  async createDefaults(): Promise<Status[]> {
    const rows: Status[] = DEFAULT_STATUSES.map((s) => ({ ...s, id: newId() }))
    await db.statuses.bulkAdd(rows)
    return rows
  },

  /**
   * Setup runs this rather than createDefaults. Re-running setup on a database
   * that already has columns would otherwise leave you with two of every one,
   * and nothing about the board would tell you why.
   */
  async ensureDefaults(): Promise<Status[]> {
    const existing = await db.statuses.orderBy('order').toArray()
    if (existing.length) return existing
    return statuses.createDefaults()
  },

  async update(id: string, patch: Partial<Omit<Status, 'id'>>) {
    await db.statuses.update(id, patch)
  },

  /** Move one status up or down; rewrites the order of the whole list. */
  async reorder(id: string, direction: -1 | 1) {
    const all = await db.statuses.orderBy('order').toArray()
    const i = all.findIndex((s) => s.id === id)
    const j = i + direction
    if (i < 0 || j < 0 || j >= all.length) return
    ;[all[i], all[j]] = [all[j], all[i]]
    await db.transaction('rw', db.statuses, async () => {
      for (let k = 0; k < all.length; k++) await db.statuses.update(all[k].id, { order: k })
    })
  },

  async add(name: string) {
    const all = await db.statuses.orderBy('order').toArray()
    const row: Status = {
      id: newId(), name, order: all.length,
      countsAsActive: false, isDone: false, wipLimit: null, stuckAfterDays: null,
    }
    await db.statuses.add(row)
    return row
  },

  /** Refuses while tasks still sit in it — losing work to a config change is not acceptable. */
  async remove(id: string): Promise<{ ok: boolean; reason?: string }> {
    const count = await db.tasks.where('statusId').equals(id).count()
    if (count > 0) return { ok: false, reason: `${count} task${count === 1 ? '' : 's'} still in this column` }
    const total = await db.statuses.count()
    if (total <= 2) return { ok: false, reason: 'A board needs at least two columns' }
    await db.statuses.delete(id)
    return { ok: true }
  },
}
