import { db } from '../db/schema'
import type { ID, Sprint, SprintEvent, Status, StatusEvent, Task } from '../db/types'
import { newId } from './ids'
import { todayISO } from './insights'
import { tasks as taskRepo } from './tasks'

const DAY = 86_400_000

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return todayISO(d)
}

export function endOfDay(iso: string): number {
  return new Date(`${iso}T23:59:59`).getTime()
}

/**
 * Monday to Friday only — a two-week sprint burns down over ten points, not
 * fourteen. Holidays come out too, or a sprint with a bank holiday in it holds
 * the team to a day's work nobody was ever going to do.
 */
export function workingDays(startISO: string, endISO: string, holidays: readonly string[] = []): string[] {
  const off = new Set(holidays)
  const out: string[] = []
  let cur = startISO
  let guard = 0
  while (cur <= endISO && guard++ < 400) {
    const day = new Date(`${cur}T12:00:00`).getDay()
    if (day !== 0 && day !== 6 && !off.has(cur)) out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

export function nextWeekday(from = new Date(), weekday = 1): string {
  const d = new Date(from)
  const delta = (weekday - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + delta)
  return todayISO(d)
}

export const sprints = {
  listForTeam: (teamId: ID) => db.sprints.where('teamId').equals(teamId).sortBy('startDate'),
  get: (id: ID) => db.sprints.get(id),

  active: (teamId: ID) =>
    db.sprints.where('teamId').equals(teamId).filter((s) => s.state === 'active').first(),

  async plan(input: {
    teamId: ID; name?: string; startDate?: string; lengthDays: number; goal?: string
    /** Set both dates by hand; when given, lengthDays is ignored. */
    endDate?: string
    /** Which weekday a first sprint starts on. Comes from settings; Monday if unset. */
    startWeekday?: number
  }): Promise<Sprint> {
    const existing = await sprints.listForTeam(input.teamId)
    const last = existing[existing.length - 1]
    const start = input.startDate
      ?? (last ? addDays(last.endDate, 3) : nextWeekday(new Date(), input.startWeekday ?? 1))
    const end = input.endDate && input.endDate >= start
      ? input.endDate
      : addDays(start, input.lengthDays - 1)
    const number = existing.length + 1
    const row: Sprint = {
      id: newId(),
      teamId: input.teamId,
      name: input.name?.trim() || `Sprint ${number}`,
      goal: input.goal ?? '',
      startDate: start,
      endDate: end,
      state: 'planned',
      closedAt: null,
    }
    await db.sprints.add(row)
    return row
  },

  /**
   * Dates can be set by hand, so this is the place that refuses a sprint that
   * ends before it starts. Left through, workingDays() returns nothing, the
   * burndown silently has no days to draw, and day counts read as zero of zero.
   */
  async update(
    id: ID,
    patch: Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate'>>,
  ): Promise<{ ok: boolean; reason?: string }> {
    const sprint = await db.sprints.get(id)
    if (!sprint) return { ok: false, reason: 'That sprint is gone' }

    const next: Partial<Sprint> = { ...patch }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) return { ok: false, reason: 'A sprint needs a name' }
      next.name = name
    }

    const startDate = next.startDate ?? sprint.startDate
    let endDate = next.endDate ?? sprint.endDate

    /*
     * Pushing the start past the end means "move this sprint", not "make it
     * impossible" — so the end comes along and the length is kept. Refusing
     * instead would mean the only way to move a sprint later is to set its end
     * date first, which is backwards from how anyone thinks about it.
     */
    if (patch.startDate !== undefined && patch.endDate === undefined && startDate > sprint.endDate) {
      const span = Math.round(
        (new Date(`${sprint.endDate}T12:00:00`).getTime()
          - new Date(`${sprint.startDate}T12:00:00`).getTime()) / DAY,
      )
      endDate = addDays(startDate, span)
      next.endDate = endDate
    }

    if (endDate < startDate) {
      return { ok: false, reason: 'A sprint cannot end before it starts' }
    }
    if (workingDays(startDate, endDate).length === 0) {
      return { ok: false, reason: 'That range is all weekend — there is nothing to burn down' }
    }

    await db.sprints.update(id, next)
    return { ok: true }
  },

  /** One active sprint per team, so "the board" is never ambiguous. */
  async activate(id: ID): Promise<{ ok: boolean; reason?: string }> {
    const sprint = await db.sprints.get(id)
    if (!sprint) return { ok: false, reason: 'That sprint is gone' }
    const running = await sprints.active(sprint.teamId)
    if (running && running.id !== id) return { ok: false, reason: `${running.name} is still running — close it first` }
    await db.sprints.update(id, { state: 'active' })
    return { ok: true }
  },

  /**
   * Closing carries the named tasks into the next sprint. The move goes through
   * tasks.setSprint like every other sprint change, so there is exactly one
   * writer of task.sprintId and one writer of sprintEvents.
   */
  async close(id: ID, carryToSprintId: ID | null, taskIds: ID[] = []) {
    await db.transaction('rw', db.sprints, db.tasks, db.sprintEvents, async () => {
      await db.sprints.update(id, { state: 'closed', closedAt: Date.now() })
      for (const taskId of taskIds) await taskRepo.setSprint(taskId, carryToSprintId)
    })
  },

  async remove(id: ID) {
    await db.transaction('rw', db.sprints, db.tasks, db.sprintEvents, db.availability, async () => {
      const inSprint = await db.tasks.where('sprintId').equals(id).toArray()
      for (const t of inSprint) await taskRepo.setSprint(t.id, null)
      // Availability only means anything for the sprint it was entered against.
      await db.availability.where('sprintId').equals(id).delete()
      await db.sprints.delete(id)
    })
  },
}

export interface BurndownPoint { date: string; remaining: number; ideal: number }

export interface SprintStats {
  total: number
  done: number
  committed: number
  addedAfterStart: number
  removed: number
  series: BurndownPoint[]
  dayIndex: number
  dayCount: number
  /** Total points in the sprint — what the burndown counts down from. */
  points: number
  pointsDone: number
}

/**
 * What one task contributes to the burndown. Sizes are points; a task nobody
 * sized still has to show up, or a sprint of unsized work charts as a flat
 * zero and the line stops meaning anything.
 */
export const weightOf = (t: Task): number => (t.size != null && t.size > 0 ? t.size : 1)

/**
 * Everything here is replayed from statusEvents and sprintEvents rather than
 * stored. That means the chart for a sprint is correct months later, and it was
 * correct for sprints that ran before this screen existed.
 */
export function sprintStats(
  sprint: Sprint,
  tasks: Task[],
  statusEvents: { taskId: ID; toStatusId: ID; at: number }[],
  sprintEvents: SprintEvent[],
  statuses: Status[],
  opts: { now?: number; holidays?: readonly string[] } = {},
): SprintStats {
  const now = opts.now ?? Date.now()
  const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))
  const inSprint = tasks.filter((t) => t.sprintId === sprint.id)
  const ids = new Set(inSprint.map((t) => t.id))

  const eventsByTask = new Map<ID, { toStatusId: ID; at: number }[]>()
  for (const e of statusEvents) {
    if (!ids.has(e.taskId)) continue
    const list = eventsByTask.get(e.taskId) ?? []
    list.push(e)
    eventsByTask.set(e.taskId, list)
  }
  for (const list of eventsByTask.values()) list.sort((a, b) => a.at - b.at)

  const startTs = endOfDay(sprint.startDate)
  const arrivals = new Map<ID, number>()
  for (const e of sprintEvents) {
    if (e.toSprintId !== sprint.id) continue
    if (!arrivals.has(e.taskId) || e.at < arrivals.get(e.taskId)!) arrivals.set(e.taskId, e.at)
  }

  let committed = 0
  let addedAfterStart = 0
  for (const t of inSprint) {
    const arrived = arrivals.get(t.id) ?? t.createdAt
    if (arrived <= startTs) committed++
    else addedAfterStart++
  }
  /**
   * Scope taken out *while the sprint was running*. Closing a sprint carries
   * unfinished work into the next one, which is also a move out of this sprint —
   * but counting that as scope removal would report every carry-over as work
   * someone pulled, which is the opposite of what happened.
   */
  const closedAt = sprint.closedAt ?? Infinity
  const removed = sprintEvents.filter(
    (e) => e.fromSprintId === sprint.id && e.toSprintId !== sprint.id && e.at < closedAt,
  ).length

  const totalPoints = inSprint.reduce((sum, t) => sum + weightOf(t), 0)
  const days = workingDays(sprint.startDate, sprint.endDate, opts.holidays)
  const series: BurndownPoint[] = days.map((date, i) => {
    const t = Math.min(endOfDay(date), now)
    let remaining = 0
    for (const task of inSprint) {
      const arrived = arrivals.get(task.id) ?? task.createdAt
      if (arrived > t) continue
      const list = eventsByTask.get(task.id) ?? []
      let status: ID | null = null
      for (const e of list) { if (e.at <= t) status = e.toStatusId; else break }
      if (status === null) continue
      if (!doneIds.has(status)) remaining += weightOf(task)
    }
    return {
      date,
      remaining,
      ideal: Math.round((totalPoints * (days.length - 1 - i)) / Math.max(1, days.length - 1)),
    }
  })

  const todayIdx = days.findIndex((d) => d >= todayISO())
  const finished = inSprint.filter((t) => doneIds.has(t.statusId))
  return {
    total: inSprint.length,
    done: finished.length,
    committed,
    addedAfterStart,
    removed,
    series,
    dayIndex: todayIdx === -1 ? days.length : todayIdx + 1,
    dayCount: days.length,
    points: totalPoints,
    pointsDone: finished.reduce((sum, t) => sum + weightOf(t), 0),
  }
}

export const sprintDay = (ms: number) => Math.floor(ms / DAY)

export interface SprintOutcome {
  sprintId: ID
  name: string
  endDate: string
  points: number
  tasks: number
}

/** Status events grouped by task, oldest first. */
export function eventsByTask(statusEvents: StatusEvent[]): Map<ID, StatusEvent[]> {
  const byTask = new Map<ID, StatusEvent[]>()
  for (const e of statusEvents) {
    const list = byTask.get(e.taskId) ?? []
    list.push(e)
    byTask.set(e.taskId, list)
  }
  for (const list of byTask.values()) list.sort((a, b) => a.at - b.at)
  return byTask
}

/**
 * The tasks a sprint delivered: finished by the time it closed, and finished
 * while they belonged to it.
 *
 * Read from the move history rather than from what still sits in the sprint:
 * closing carries unfinished work out, so counting current membership would
 * quietly report every sprint as having delivered everything it held.
 *
 * `sprintIdAtTime` is what makes this honest. Every move has recorded which
 * sprint the task belonged to at that moment since v1, so "finished while in
 * this sprint" is a fact in the log rather than something inferred afterwards.
 */
export function finishedIn(
  sprint: Sprint,
  tasks: Task[],
  byTask: Map<ID, StatusEvent[]>,
  doneIds: Set<ID>,
): Task[] {
  const at = sprint.closedAt ?? endOfDay(sprint.endDate)
  return tasks.filter((task) => {
    const list = byTask.get(task.id)
    if (!list) return false
    let last: StatusEvent | null = null
    for (const e of list) { if (e.at <= at) last = e; else break }
    return !!last && doneIds.has(last.toStatusId) && last.sprintIdAtTime === sprint.id
  })
}

/** Points delivered per sprint, for velocity. */
export function velocity(
  closed: Sprint[],
  tasks: Task[],
  statusEvents: StatusEvent[],
  statuses: Status[],
): SprintOutcome[] {
  const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))
  const byTask = eventsByTask(statusEvents)

  return closed.map((sprint) => {
    const done = finishedIn(sprint, tasks, byTask, doneIds)
    return {
      sprintId: sprint.id,
      name: sprint.name,
      endDate: sprint.endDate,
      points: done.reduce((sum, t) => sum + weightOf(t), 0),
      tasks: done.length,
    }
  })
}
