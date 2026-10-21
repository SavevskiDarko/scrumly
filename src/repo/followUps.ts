import { db } from '../db/schema'
import type { FollowUp, ID } from '../db/types'
import { newId } from './ids'
import { todayISO } from './insights'

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Pulled forward from slice 5 because stand-up mode needs somewhere to put
 * "talk to Jakim about load" — which is yours, not a task for a developer,
 * and rots if it goes in the backlog.
 */
export const followUps = {
  listOpen: () => db.followUps.filter((f) => f.doneAt === null).toArray(),
  listDone: () => db.followUps.filter((f) => f.doneAt !== null).toArray(),

  async create(input: { title: string; dueDate?: string | null; personId?: ID | null; sprintId?: ID | null }) {
    const title = input.title.trim()
    if (!title) throw new Error('A follow-up needs a title')
    const row: FollowUp = {
      id: newId(),
      title,
      dueDate: input.dueDate ?? null,
      personId: input.personId ?? null,
      sprintId: input.sprintId ?? null,
      sourceNoteId: null,
      doneAt: null,
      createdAt: Date.now(),
    }
    await db.followUps.add(row)
    return row
  },

  complete: (id: ID) => db.followUps.update(id, { doneAt: Date.now() }),
  reopen: (id: ID) => db.followUps.update(id, { doneAt: null }),
  remove: (id: ID) => db.followUps.delete(id),

  /** Captured mid-sentence during a stand-up, so they are often typed badly. */
  async rename(id: ID, title: string) {
    const next = title.trim()
    if (!next) return
    await db.followUps.update(id, { title: next })
  },

  /**
   * Null clears it. Stored as 'YYYY-MM-DD' like every other date, because the
   * order below and every overdue check compare it as a plain string.
   */
  async setDue(id: ID, dueDate: string | null) {
    if (dueDate !== null && !ISO_DAY.test(dueDate)) throw new Error('A due date is stored as YYYY-MM-DD')
    await db.followUps.update(id, { dueDate })
  },
}

export type FollowUpDue = 'overdue' | 'today' | 'later' | 'none'

/** Where a follow-up stands against its date. One that is done is late for nothing. */
export function followUpDue(f: FollowUp, today = todayISO()): FollowUpDue {
  if (!f.dueDate || f.doneAt !== null) return 'none'
  if (f.dueDate < today) return 'overdue'
  return f.dueDate === today ? 'today' : 'later'
}

/**
 * Open follow-ups in the order they need doing. Anything with a date goes by
 * that date, so the overdue ones come first and today's straight after them;
 * then everything without one, longest-waiting first, because that is the one
 * nagging you. The assistant reads them in the same order.
 */
export function byDue(a: FollowUp, b: FollowUp): number {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1
    if (!b.dueDate) return -1
    return a.dueDate < b.dueDate ? -1 : 1
  }
  return a.createdAt - b.createdAt
}
