import type { Blocker, ID, Person, Status, Task } from '../db/types'
import { daysInStatus } from './tasks'

export function todayISO(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export interface BoardIndex {
  byStatus: Map<ID, Status>
  byPerson: Map<ID, Person>
  blockerByTask: Map<ID, Blocker>
  doneIds: Set<ID>
  activeIds: Set<ID>
  backlogId: ID | null
}

export function buildIndex(statuses: Status[], people: Person[], openBlockers: Blocker[]): BoardIndex {
  return {
    byStatus: new Map(statuses.map((s) => [s.id, s])),
    byPerson: new Map(people.map((p) => [p.id, p])),
    blockerByTask: new Map(openBlockers.map((b) => [b.taskId, b])),
    doneIds: new Set(statuses.filter((s) => s.isDone).map((s) => s.id)),
    activeIds: new Set(statuses.filter((s) => s.countsAsActive).map((s) => s.id)),
    backlogId: statuses.length ? statuses[0].id : null,
  }
}

export type OwnerField = 'assigneeId' | 'reviewerId' | 'testerId'

/**
 * Which person field a column makes answerable. Matched on column name so it
 * works out of the box with the default columns; rename them and everything
 * falls back to the assignee, which is wrong but never misleading.
 *
 * One function so that reading an owner and assigning one by drag can never
 * disagree about which field they mean.
 */
export function ownerFieldFor(status: Status | undefined): OwnerField {
  const name = (status?.name ?? '').toLowerCase()
  if (/review/.test(name)) return 'reviewerId'
  if (/\bqa\b|test/.test(name)) return 'testerId'
  return 'assigneeId'
}

/** Who is answerable for a task right now, falling back to the assignee. */
export function ownerOf(task: Task, status: Status | undefined, ix: BoardIndex): Person | null {
  const id = task[ownerFieldFor(status)] ?? task.assigneeId
  return id ? ix.byPerson.get(id) ?? null : null
}

export const isBlocked = (t: Task, ix: BoardIndex) => ix.blockerByTask.has(t.id)
export const isDoneTask = (t: Task, ix: BoardIndex) => ix.doneIds.has(t.statusId)

export function isOverdue(t: Task, ix: BoardIndex, today = todayISO()): boolean {
  return !!t.dueDate && t.dueDate < today && !isDoneTask(t, ix)
}

export function isStuckTask(t: Task, ix: BoardIndex, now = Date.now()): boolean {
  const s = ix.byStatus.get(t.statusId)
  if (!s || s.stuckAfterDays == null || s.isDone) return false
  return daysInStatus(t, now) >= s.stuckAfterDays
}

/** Unassigned excludes the first column: nobody owning a backlog item is normal. */
export function isUnowned(t: Task, ix: BoardIndex): boolean {
  if (isDoneTask(t, ix)) return false
  if (ix.backlogId && t.statusId === ix.backlogId) return false
  return !t.assigneeId
}

export type Bucket = 'blocked' | 'stuck' | 'overdue' | 'unowned'

export function bucketOf(t: Task, ix: BoardIndex): Record<Bucket, boolean> {
  return {
    blocked: isBlocked(t, ix),
    stuck: isStuckTask(t, ix),
    overdue: isOverdue(t, ix),
    unowned: isUnowned(t, ix),
  }
}

export function filterByBucket(tasks: Task[], ix: BoardIndex, bucket: Bucket): Task[] {
  return tasks.filter((t) => bucketOf(t, ix)[bucket])
}

export interface Load { person: Person; active: Task[]; blocked: number }

export function loadByPerson(tasks: Task[], people: Person[], ix: BoardIndex): Load[] {
  return people.map((person) => {
    const mine = tasks.filter((t) => {
      if (!ix.activeIds.has(t.statusId)) return false
      const owner = ownerOf(t, ix.byStatus.get(t.statusId), ix)
      return owner?.id === person.id || t.assigneeId === person.id
    })
    return { person, active: mine, blocked: mine.filter((t) => isBlocked(t, ix)).length }
  })
}

/**
 * How long one task took from the moment real work started on it to the moment
 * it landed in a done column. Waiting in the backlog is not cycle time, which is
 * why this starts at the first column marked as active work rather than at
 * creation. Returns null for anything that never passed through active work.
 */
export function cycleTimeOf(events: { toStatusId: ID; at: number }[], ix: BoardIndex): number | null {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  let startedAt: number | null = null
  for (const e of sorted) {
    if (startedAt === null && ix.activeIds.has(e.toStatusId)) startedAt = e.at
    if (startedAt !== null && ix.doneIds.has(e.toStatusId)) {
      return Math.max(0, (e.at - startedAt) / 86_400_000)
    }
  }
  return null
}

export interface FlowStats {
  sampled: number
  medianDays: number | null
  /** The slow tail. A median alone hides the task that took three weeks. */
  p85Days: number | null
}

export function flowStats(
  tasks: Task[],
  statusEvents: { taskId: ID; toStatusId: ID; at: number }[],
  ix: BoardIndex,
  since = 0,
): FlowStats {
  const byTask = new Map<ID, { toStatusId: ID; at: number }[]>()
  for (const e of statusEvents) {
    const list = byTask.get(e.taskId) ?? []
    list.push(e)
    byTask.set(e.taskId, list)
  }

  const samples: number[] = []
  for (const t of tasks) {
    if (!ix.doneIds.has(t.statusId)) continue
    if (t.closedAt == null || t.closedAt < since) continue
    const days = cycleTimeOf(byTask.get(t.id) ?? [], ix)
    if (days != null) samples.push(days)
  }
  samples.sort((a, b) => a - b)
  const at = (p: number) =>
    (samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] : null)
  return { sampled: samples.length, medianDays: at(0.5), p85Days: at(0.85) }
}

export interface Queue { status: Status; entries: { person: Person | null; count: number; oldestDays: number }[] }

/** One queue per column marked as active work, showing who is holding it up. */
export function queues(tasks: Task[], statuses: Status[], ix: BoardIndex, now = Date.now()): Queue[] {
  return statuses
    .filter((s) => s.countsAsActive)
    .map((status) => {
      const inCol = tasks.filter((t) => t.statusId === status.id)
      const grouped = new Map<string, { person: Person | null; count: number; oldestDays: number }>()
      for (const t of inCol) {
        const owner = ownerOf(t, status, ix)
        const key = owner?.id ?? '—'
        const days = daysInStatus(t, now)
        const cur = grouped.get(key)
        if (cur) { cur.count++; cur.oldestDays = Math.max(cur.oldestDays, days) }
        else grouped.set(key, { person: owner, count: 1, oldestDays: days })
      }
      return {
        status,
        entries: [...grouped.values()].sort((a, b) => b.oldestDays - a.oldestDays),
      }
    })
    .filter((q) => q.entries.length > 0)
}
