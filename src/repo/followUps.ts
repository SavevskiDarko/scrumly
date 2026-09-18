import { db } from '../db/schema'
import type { FollowUp, ID } from '../db/types'
import { newId } from './ids'

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
}
