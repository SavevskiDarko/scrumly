import { db } from '../db/schema'
import type { Availability, ID, Person, Sprint, Task } from '../db/types'
import { newId } from './ids'
import { weightOf, workingDays, type SprintOutcome } from './sprints'

export const availability = {
  forSprint: (sprintId: ID) => db.availability.where('sprintId').equals(sprintId).toArray(),
  forSprints: (sprintIds: ID[]) => db.availability.where('sprintId').anyOf(sprintIds).toArray(),

  /**
   * Days one person has for one sprint. Null clears it back to "every working
   * day", so a row only exists where somebody is actually out — and a sprint
   * nobody entered anything for still has a capacity.
   */
  async set(personId: ID, sprintId: ID, days: number | null) {
    await db.transaction('rw', db.availability, async () => {
      const existing = await db.availability.where('sprintId').equals(sprintId)
        .filter((a) => a.personId === personId).toArray()
      if (days == null || !Number.isFinite(days)) {
        await db.availability.bulkDelete(existing.map((a) => a.id))
        return
      }
      // Half days are real; anything finer is noise from typing.
      const clean = Math.max(0, Math.round(days * 2) / 2)
      if (existing.length) {
        await db.availability.update(existing[0].id, { daysAvailable: clean })
        await db.availability.bulkDelete(existing.slice(1).map((a) => a.id))
      } else {
        const row: Availability = { id: newId(), personId, sprintId, daysAvailable: clean }
        await db.availability.add(row)
      }
    })
  },
}

export interface CapacityRow {
  person: Person
  /** Days this person has in the sprint. */
  days: number
  /** False when nothing was entered and every working day is assumed. */
  entered: boolean
  points: number
  tasks: number
  /** Their slice of the forecast, in proportion to the days they have. Null with no history. */
  share: number | null
}

export interface CapacityPlan {
  workingDays: number
  /** Person-days the team actually has in this sprint. */
  personDays: number
  /** Person-days if everyone were in every working day. */
  fullPersonDays: number
  rows: CapacityRow[]
  plannedPoints: number
  plannedTasks: number
  unassignedPoints: number
  /** Points held by someone who is no longer in this team. */
  elsewherePoints: number
  /** Tasks with no size. Each counts as one point, same as the burndown. */
  unsized: number
  averageVelocity: number | null
  /** Points delivered per available person-day, over the sprints the forecast reads. */
  rate: number | null
  /** What the team has actually finished, scaled to the days it has this time. */
  forecast: number | null
  basedOn: number
}

/**
 * Yesterday's weather, adjusted for who is in.
 *
 * The forecast is not average velocity. A sprint with a bank holiday and two
 * people on leave is not the same sprint as last one, and planning it against
 * last one's number is how a team commits to work it was never going to
 * finish. So past sprints are turned into points per person-day, and that
 * rate is multiplied by the person-days this sprint really has.
 *
 * Past sprints read today's team, using any availability entered for them and
 * assuming full days where none was. It reads the same six closed sprints the
 * Sprints screen averages, so the two never quote different velocities.
 */
export function capacityPlan(input: {
  sprint: Sprint
  members: Person[]
  tasks: Task[]
  availability: Availability[]
  history: SprintOutcome[]
  sprints: Sprint[]
  holidays?: readonly string[]
}): CapacityPlan {
  const { sprint, members, holidays = [] } = input
  const daysIn = (s: Sprint) => workingDays(s.startDate, s.endDate, holidays).length

  const daysFor = (personId: ID, s: Sprint, full: number) => {
    const row = input.availability.find((a) => a.personId === personId && a.sprintId === s.id)
    return { days: row ? Math.min(row.daysAvailable, full) : full, entered: Boolean(row) }
  }

  const wd = daysIn(sprint)
  const inSprint = input.tasks.filter((t) => t.sprintId === sprint.id)
  const memberIds = new Set(members.map((m) => m.id))

  const byId = new Map(input.sprints.map((s) => [s.id, s]))
  const recent = input.history
    .filter((h) => h.sprintId !== sprint.id)
    .slice(-6)
    .filter((h) => h.tasks > 0 && byId.has(h.sprintId))
  let pastPoints = 0
  let pastDays = 0
  for (const h of recent) {
    const s = byId.get(h.sprintId)!
    const full = daysIn(s)
    pastPoints += h.points
    for (const m of members) pastDays += daysFor(m.id, s, full).days
  }

  const personDays = members.reduce((sum, m) => sum + daysFor(m.id, sprint, wd).days, 0)
  const rate = pastDays > 0 ? pastPoints / pastDays : null
  const forecast = rate != null ? Math.round(rate * personDays) : null

  const rows: CapacityRow[] = members.map((person) => {
    const { days, entered } = daysFor(person.id, sprint, wd)
    const mine = inSprint.filter((t) => t.assigneeId === person.id)
    return {
      person,
      days,
      entered,
      points: mine.reduce((sum, t) => sum + weightOf(t), 0),
      tasks: mine.length,
      share: forecast != null && personDays > 0 ? (forecast * days) / personDays : null,
    }
  })

  return {
    workingDays: wd,
    personDays,
    fullPersonDays: wd * members.length,
    rows,
    plannedPoints: inSprint.reduce((sum, t) => sum + weightOf(t), 0),
    plannedTasks: inSprint.length,
    unassignedPoints: inSprint.filter((t) => !t.assigneeId).reduce((sum, t) => sum + weightOf(t), 0),
    elsewherePoints: inSprint
      .filter((t) => t.assigneeId && !memberIds.has(t.assigneeId))
      .reduce((sum, t) => sum + weightOf(t), 0),
    unsized: inSprint.filter((t) => t.size == null).length,
    averageVelocity: recent.length ? Math.round(pastPoints / recent.length) : null,
    rate,
    forecast,
    basedOn: recent.length,
  }
}
