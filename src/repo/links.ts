import { db } from '../db/schema'
import type { ID, Sprint, Task, TaskLink } from '../db/types'
import { newId } from './ids'

/**
 * Dependencies between tasks, in either team. Stored one way round — from the
 * task being waited on to the task doing the waiting — and read both ways.
 *
 * Not the same thing as a blocker. A blocker is something that has already
 * stopped work and is costing days; a dependency is known in advance and is
 * a scheduling question: will the other thing land first?
 */
export const links = {
  all: () => db.taskLinks.toArray(),

  async forTask(taskId: ID): Promise<{ waitsOn: TaskLink[]; holdsUp: TaskLink[] }> {
    const [waitsOn, holdsUp] = await Promise.all([
      db.taskLinks.where('toTaskId').equals(taskId).toArray(),
      db.taskLinks.where('fromTaskId').equals(taskId).toArray(),
    ])
    return { waitsOn, holdsUp }
  },

  /** `waiterId` cannot finish until `blockerId` has. Refuses itself, repeats and loops. */
  async add(blockerId: ID, waiterId: ID): Promise<{ ok: boolean; reason?: string; link?: TaskLink }> {
    if (blockerId === waiterId) return { ok: false, reason: 'A task cannot wait on itself' }
    return db.transaction('rw', db.taskLinks, db.tasks, async () => {
      const [blocker, waiter] = await Promise.all([db.tasks.get(blockerId), db.tasks.get(waiterId)])
      if (!blocker || !waiter) return { ok: false, reason: 'That task is gone' }
      const all = await db.taskLinks.toArray()
      if (all.some((l) => l.fromTaskId === blockerId && l.toTaskId === waiterId)) {
        return { ok: false, reason: `${waiter.key} already waits on ${blocker.key}` }
      }
      // A loop can never be scheduled: each side waits for the other forever.
      if (reaches(all, waiterId, blockerId)) {
        return { ok: false, reason: `${blocker.key} already waits on ${waiter.key}, so that would be a loop` }
      }
      const link: TaskLink = { id: newId(), fromTaskId: blockerId, toTaskId: waiterId, type: 'blocks' }
      await db.taskLinks.add(link)
      return { ok: true, link }
    })
  },

  remove: (id: ID) => db.taskLinks.delete(id),
}

/** Whether following "blocks" arrows from `start` ever arrives at `target`. */
export function reaches(all: TaskLink[], start: ID, target: ID): boolean {
  const next = new Map<ID, ID[]>()
  for (const l of all) {
    const list = next.get(l.fromTaskId) ?? []
    list.push(l.toTaskId)
    next.set(l.fromTaskId, list)
  }
  const seen = new Set<ID>([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    if (cur === target) return true
    for (const n of next.get(cur) ?? []) {
      if (!seen.has(n)) { seen.add(n); queue.push(n) }
    }
  }
  return false
}

/**
 * - done: the thing waited on has landed
 * - ahead: it is scheduled in a sprint that ends before the waiting one starts
 * - tight: the two overlap, so it has to land partway through
 * - late: it is scheduled to finish after the waiting sprint ends
 * - unscheduled: it is in no sprint at all, so nothing says when it lands
 */
export type DependencyState = 'done' | 'ahead' | 'tight' | 'late' | 'unscheduled'

export const DEPENDENCY_LABEL: Record<DependencyState, string> = {
  done: 'Done',
  ahead: 'Lands first',
  tight: 'Tight',
  late: 'Lands after',
  unscheduled: 'Not scheduled',
}

export const DEPENDENCY_HINT: Record<DependencyState, string> = {
  done: 'Already finished',
  ahead: 'Scheduled in a sprint that ends before this one starts',
  tight: 'Scheduled in a sprint that overlaps this one — it has to land partway through',
  late: 'Scheduled to finish after this sprint ends',
  unscheduled: 'In no sprint, so nothing says when it lands',
}

/** Worst first. */
const SEVERITY: DependencyState[] = ['late', 'unscheduled', 'tight', 'ahead', 'done']

export function worstState(states: DependencyState[]): DependencyState | null {
  for (const s of SEVERITY) if (states.includes(s)) return s
  return null
}

/**
 * Compares sprint dates rather than sprint identity, because across teams the
 * sprints are different rows that happen to cover the same weeks.
 *
 * `waiterSprintId` overrides where the waiting task sits, so a planning screen
 * can ask "if I pull this in, will what it needs be there?"
 */
export function dependencyState(
  blocker: Task | undefined,
  waiter: Task | undefined,
  sprintById: Map<ID, Sprint>,
  doneIds: Set<ID>,
  waiterSprintId?: ID | null,
): DependencyState {
  if (!blocker) return 'unscheduled'
  if (doneIds.has(blocker.statusId)) return 'done'
  const bs = blocker.sprintId ? sprintById.get(blocker.sprintId) : undefined
  if (!bs || bs.state === 'closed') return 'unscheduled'
  const wId = waiterSprintId !== undefined ? waiterSprintId : waiter?.sprintId ?? null
  const ws = wId ? sprintById.get(wId) : undefined
  // Nothing to compare against: the waiting task is not planned yet.
  if (!ws) return 'ahead'
  if (bs.endDate < ws.startDate) return 'ahead'
  if (bs.endDate > ws.endDate) return 'late'
  return 'tight'
}
