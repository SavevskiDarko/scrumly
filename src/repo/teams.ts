import { db } from '../db/schema'
import type { ID, Team } from '../db/types'
import { newId } from './ids'

function prefixFrom(name: string): string {
  const letters = name.replace(/[^A-Za-z ]/g, '').trim()
  if (!letters) return 'TSK'
  const words = letters.split(/\s+/)
  if (words.length > 1) return words.map((w) => w[0]).join('').slice(0, 4).toUpperCase()
  return words[0].slice(0, 3).toUpperCase()
}

export const teams = {
  list: () => db.teams.orderBy('name').toArray(),
  get: (id: ID) => db.teams.get(id),

  async create(input: { name: string; keyPrefix?: string }) {
    const name = input.name.trim() || 'Team'
    const row: Team = {
      id: newId(),
      name,
      keyPrefix: (input.keyPrefix?.trim() || prefixFrom(name)).toUpperCase(),
      nextTaskNumber: 1,
      createdAt: Date.now(),
      archivedAt: null,
    }
    await db.teams.add(row)
    return row
  },

  async update(id: ID, patch: Partial<Pick<Team, 'name' | 'keyPrefix'>>) {
    const next: Partial<Team> = { ...patch }
    if (next.keyPrefix) next.keyPrefix = next.keyPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '')
    await db.teams.update(id, next)
  },

  /**
   * Remembers the order stand-ups should run in. Passing null forgets it, and
   * the team goes back to rotating alphabetically.
   */
  async setStandupOrder(id: ID, order: ID[] | null) {
    // An empty array rather than undefined: Dexie's meaning for an undefined
    // value in update() is "delete this property", which is a subtlety nobody
    // reading this should have to know. Empty and absent are read the same way.
    await db.teams.update(id, { standupOrder: order ?? [] })
  },

  /**
   * Keeps the team on this computer only, or lets it travel again. Only the
   * flag: telling the synced copy about it is sync's job (keepOnThisComputer).
   */
  async setLocalOnly(id: ID, on: boolean) {
    // Undefined in update() is Dexie for "remove this property".
    await db.teams.update(id, { localOnly: on ? true : undefined })
  },

  /** Refuses while the team still owns work — losing a board to a stray click is not acceptable. */
  async remove(id: ID): Promise<{ ok: boolean; reason?: string }> {
    const taskCount = await db.tasks.where('teamId').equals(id).count()
    if (taskCount > 0) return { ok: false, reason: `${taskCount} task${taskCount === 1 ? '' : 's'} still belong to this team` }
    const sprintCount = await db.sprints.where('teamId').equals(id).count()
    if (sprintCount > 0) return { ok: false, reason: `${sprintCount} sprint${sprintCount === 1 ? '' : 's'} still belong to this team` }
    const total = await db.teams.count()
    if (total <= 1) return { ok: false, reason: 'You need at least one team' }

    await db.transaction('rw', db.teams, db.people, db.standups, db.standupNotes, async () => {
      const members = await db.people.where('teamIds').equals(id).toArray()
      for (const m of members) {
        await db.people.update(m.id, { teamIds: m.teamIds.filter((t) => t !== id) })
      }
      // The notes go with the stand-ups they belong to; orphaned rows would
      // otherwise surface against people who joined another team.
      await db.standupNotes.where('teamId').equals(id).delete()
      await db.standups.where('teamId').equals(id).delete()
      await db.teams.delete(id)
    })
    return { ok: true }
  },

  suggestPrefix: prefixFrom,
}
