import { db } from '../db/schema'
import type { ID, Standup, StandupNote } from '../db/types'
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

/**
 * The order a stand-up actually runs in.
 *
 * With no arranged order, it rotates alphabetically, so the same person is not
 * always last — which is what every stand-up did before the order could be
 * arranged, and is still the right default for a team that has not thought
 * about it.
 *
 * With one, it is used as given and not rotated. Rotating an order somebody
 * chose on purpose would look like the app losing their arrangement.
 *
 * Membership moves underneath a saved order: people who have left are dropped,
 * and people who have joined go on the end rather than being silently left out
 * of the meeting. `members` is expected in the fallback order (by name), so
 * newcomers arrive alphabetically among themselves.
 */
export function runningOrder(members: ID[], arranged: ID[] | undefined | null, rotateBy: number): ID[] {
  if (!arranged || arranged.length === 0) return rotate(members, rotateBy)
  const present = new Set(members)
  const kept = arranged.filter((id) => present.has(id))
  const known = new Set(kept)
  return [...kept, ...members.filter((id) => !known.has(id))]
}

function dayOfYear(d = new Date()): number {
  const start = new Date(d.getFullYear(), 0, 0)
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000)
}

export const standups = {
  latest: (teamId: ID) =>
    db.standups.where('teamId').equals(teamId).reverse().sortBy('startedAt').then((r) => r[0] ?? null),

  /**
   * Who this team's next stand-up would run through, in order. The screen shows
   * this before you start, so what is arranged there is what actually happens.
   */
  async nextOrder(teamId: ID): Promise<ID[]> {
    // Deliberately no fallback to every active person: running a stand-up for
    // the wrong team is worse than being told the team is empty.
    const members = await db.people.where('teamIds').equals(teamId).filter((p) => p.active).sortBy('name')
    const team = await db.teams.get(teamId)
    return runningOrder(members.map((p) => p.id), team?.standupOrder, dayOfYear())
  },

  async start(teamId: ID): Promise<Standup> {
    const row: Standup = {
      id: newId(),
      teamId,
      sprintId: null,
      date: todayISO(),
      startedAt: Date.now(),
      endedAt: null,
      personOrder: await standups.nextOrder(teamId),
    }
    await db.standups.add(row)
    return row
  },

  end: (id: ID) => db.standups.update(id, { endedAt: Date.now() }),

  /** Abandoning takes the notes with it — there was no meeting to remember. */
  async cancel(id: ID) {
    await db.transaction('rw', db.standups, db.standupNotes, async () => {
      await db.standupNotes.where('standupId').equals(id).delete()
      await db.standups.delete(id)
    })
  },

  /** What this person said at this stand-up, if anything was written down. */
  note: (standupId: ID, personId: ID) =>
    db.standupNotes.where('[standupId+personId]').equals([standupId, personId]).first(),

  /**
   * One note per person per stand-up, so this overwrites rather than piling up
   * a row per keystroke-flush. Clearing the box removes the row instead of
   * leaving an empty one to read back tomorrow as though nothing was said.
   */
  async saveNote(input: { standupId: ID; teamId: ID; personId: ID; text: string }): Promise<void> {
    const text = input.text.trim()
    const existing = await standups.note(input.standupId, input.personId)

    if (!text) {
      if (existing) await db.standupNotes.delete(existing.id)
      return
    }
    if (existing) {
      await db.standupNotes.update(existing.id, { text })
      return
    }

    const standup = await db.standups.get(input.standupId)
    if (!standup) return
    await db.standupNotes.add({
      id: newId(),
      standupId: input.standupId,
      teamId: input.teamId,
      personId: input.personId,
      text,
      // Stamped with the stand-up, not with now: "the one before this" has to
      // stay correct even if somebody tidies up an old note next week.
      date: standup.date,
      at: standup.startedAt,
    })
  },

  /**
   * The last thing this person said, before the stand-up now running. Not
   * necessarily yesterday's — somebody away on Tuesday should still have
   * Monday's words read back to them on Wednesday.
   */
  async previousNote(personId: ID, beforeAt: number): Promise<StandupNote | null> {
    const mine = await db.standupNotes.where('personId').equals(personId).toArray()
    const earlier = mine.filter((n) => n.at < beforeAt).sort((a, b) => a.at - b.at)
    return earlier[earlier.length - 1] ?? null
  },

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
