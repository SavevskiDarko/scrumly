import { db } from '../db/schema'
import type { ID, Standup } from '../db/types'
import { newId } from './ids'
import { todayISO } from './insights'

export interface StandupSummary {
  moved: number
  blockersOpened: number
  blockersResolved: number
  chases: number
  tasksCreated: number
  followUps: number
  minutes: number
}

/** Rotates the running order so the same person is not always last. */
export function rotate<T>(items: T[], by: number): T[] {
  if (items.length < 2) return items
  const n = ((by % items.length) + items.length) % items.length
  return [...items.slice(n), ...items.slice(0, n)]
}

function dayOfYear(d = new Date()): number {
  const start = new Date(d.getFullYear(), 0, 0)
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000)
}

export const standups = {
  latest: (teamId: ID) =>
    db.standups.where('teamId').equals(teamId).reverse().sortBy('startedAt').then((r) => r[0] ?? null),

  async start(teamId: ID): Promise<Standup> {
    // Deliberately no fallback to every active person: running a stand-up for
    // the wrong team is worse than being told the team is empty.
    const members = await db.people.where('teamIds').equals(teamId).filter((p) => p.active).sortBy('name')
    const row: Standup = {
      id: newId(),
      teamId,
      sprintId: null,
      date: todayISO(),
      startedAt: Date.now(),
      endedAt: null,
      personOrder: rotate(members.map((p) => p.id), dayOfYear()),
    }
    await db.standups.add(row)
    return row
  },

  end: (id: ID) => db.standups.update(id, { endedAt: Date.now() }),
  cancel: (id: ID) => db.standups.delete(id),

  /** What actually changed while the meeting was running. */
  async summary(standup: Standup): Promise<StandupSummary> {
    const from = standup.startedAt
    const to = standup.endedAt ?? Date.now()
    const within = (t: number) => t >= from && t <= to

    const events = await db.statusEvents.where('at').between(from, to, true, true).toArray()
    const allBlockers = await db.blockers.toArray()
    const chases = await db.chases.toArray()
    const created = await db.tasks.filter((t) => within(t.createdAt)).count()
    const fu = await db.followUps.filter((f) => within(f.createdAt)).count()

    return {
      moved: events.filter((e) => e.fromStatusId !== null).length,
      tasksCreated: created,
      blockersOpened: allBlockers.filter((b) => within(b.openedAt)).length,
      blockersResolved: allBlockers.filter((b) => b.resolvedAt !== null && within(b.resolvedAt)).length,
      chases: chases.filter((c) => within(c.at)).length,
      followUps: fu,
      minutes: Math.max(0, Math.round((to - from) / 60_000)),
    }
  },
}
