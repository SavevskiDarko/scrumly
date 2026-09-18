import { db } from '../db/schema'
import type { ID, Priority, Task } from '../db/types'
import { newId } from './ids'

const ORDER_STEP = 1024
const byOrder = (a: Task, b: Task) => a.orderInColumn - b.orderInColumn

export interface CreateTaskInput {
  teamId: ID
  statusId: ID
  title: string
  description?: string
  assigneeId?: ID | null
  reviewerId?: ID | null
  testerId?: ID | null
  priority?: Priority
  size?: number | null
  dueDate?: string | null
  project?: string | null
  tags?: string[]
  sprintId?: ID | null
}

/** Everything a screen may change about a task EXCEPT its status. */
export type TaskPatch = Partial<Omit<Task, 'id' | 'key' | 'statusId' | 'createdAt' | 'statusChangedAt' | 'orderInColumn'>>

async function columnTasks(teamId: ID, statusId: ID, excludeId?: ID) {
  const rows = await db.tasks.where('[teamId+statusId]').equals([teamId, statusId]).toArray()
  return rows.filter((t) => t.id !== excludeId).sort(byOrder)
}

export const tasks = {
  get: (id: ID) => db.tasks.get(id),
  listForTeam: (teamId: ID) => db.tasks.where('teamId').equals(teamId).toArray(),
  listForColumn: (teamId: ID, statusId: ID) => columnTasks(teamId, statusId),
  listForAssignee: (personId: ID) => db.tasks.where('assigneeId').equals(personId).toArray(),

  async create(input: CreateTaskInput): Promise<Task> {
    const title = input.title.trim()
    if (!title) throw new Error('A task needs a title')

    return db.transaction('rw', db.teams, db.tasks, db.statusEvents, async () => {
      const team = await db.teams.get(input.teamId)
      if (!team) throw new Error('Unknown team')
      await db.teams.update(team.id, { nextTaskNumber: team.nextTaskNumber + 1 })

      const column = await columnTasks(input.teamId, input.statusId)
      const order = column.length ? column[column.length - 1].orderInColumn + ORDER_STEP : ORDER_STEP
      const now = Date.now()

      const task: Task = {
        id: newId(),
        key: `${team.keyPrefix}-${team.nextTaskNumber}`,
        teamId: input.teamId,
        sprintId: input.sprintId ?? null,
        title,
        description: input.description ?? '',
        assigneeId: input.assigneeId ?? null,
        reviewerId: input.reviewerId ?? null,
        testerId: input.testerId ?? null,
        statusId: input.statusId,
        priority: input.priority ?? 'normal',
        size: input.size ?? null,
        dueDate: input.dueDate ?? null,
        project: input.project ?? null,
        tags: input.tags ?? [],
        orderInColumn: order,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        closedAt: null,
      }

      await db.tasks.add(task)
      await db.statusEvents.add({
        id: newId(), taskId: task.id, fromStatusId: null,
        toStatusId: task.statusId, at: now, sprintIdAtTime: task.sprintId,
      })
      return task
    })
  },

  /**
   * The ONLY function permitted to change statusId, and the only writer of
   * statusEvents. Every derived number in the product — days in column, stuck
   * lists, carry-over, burndown, cycle time — is computed from that table, so
   * routing every move through here is what makes those features possible later.
   */
  async move(id: ID, toStatusId: ID, insertBeforeTaskId: ID | null = null) {
    await db.transaction('rw', db.tasks, db.statusEvents, db.statuses, async () => {
      const task = await db.tasks.get(id)
      if (!task) return
      const toStatus = await db.statuses.get(toStatusId)
      if (!toStatus) return

      const column = await columnTasks(task.teamId, toStatusId, id)
      let order: number
      if (insertBeforeTaskId) {
        const idx = column.findIndex((t) => t.id === insertBeforeTaskId)
        if (idx === -1) {
          order = column.length ? column[column.length - 1].orderInColumn + ORDER_STEP : ORDER_STEP
        } else {
          const prev = idx > 0 ? column[idx - 1].orderInColumn : 0
          order = (prev + column[idx].orderInColumn) / 2
        }
      } else {
        order = column.length ? column[column.length - 1].orderInColumn + ORDER_STEP : ORDER_STEP
      }

      const now = Date.now()
      const statusChanged = task.statusId !== toStatusId

      await db.tasks.update(id, {
        statusId: toStatusId,
        orderInColumn: order,
        updatedAt: now,
        ...(statusChanged ? { statusChangedAt: now } : {}),
        ...(statusChanged ? { closedAt: toStatus.isDone ? now : null } : {}),
      })

      if (statusChanged) {
        await db.statusEvents.add({
          id: newId(), taskId: id, fromStatusId: task.statusId,
          toStatusId, at: now, sprintIdAtTime: task.sprintId,
        })
      }
    })
  },

  async update(id: ID, patch: TaskPatch) {
    if ('statusId' in (patch as Record<string, unknown>)) {
      throw new Error('Status changes must go through tasks.move so the history stays honest')
    }
    await db.tasks.update(id, { ...patch, updatedAt: Date.now() })
  },

  /**
   * Takes everything that pointed at the task with it. A chase belongs to a
   * blocker, so deleting the blocker without its chases leaves rows nothing can
   * ever reach again; the same goes for the sprint log, the note that spawned
   * it and any diagram pinned to it.
   */
  async remove(id: ID) {
    await db.transaction(
      'rw',
      [db.tasks, db.statusEvents, db.taskLinks, db.externalLinks, db.blockers,
        db.chases, db.sprintEvents, db.conversions, db.boardLinks],
      async () => {
        const blockerIds = await db.blockers.where('taskId').equals(id).primaryKeys() as ID[]
        for (const blockerId of blockerIds) {
          await db.chases.where('blockerId').equals(blockerId).delete()
        }
        await db.tasks.delete(id)
        await db.statusEvents.where('taskId').equals(id).delete()
        await db.taskLinks.where('fromTaskId').equals(id).delete()
        await db.taskLinks.where('toTaskId').equals(id).delete()
        await db.externalLinks.where('taskId').equals(id).delete()
        await db.blockers.where('taskId').equals(id).delete()
        await db.sprintEvents.where('taskId').equals(id).delete()
        await db.conversions.where('createdId').equals(id)
          .filter((c) => c.createdType === 'task').delete()
        await db.boardLinks.where('entityId').equals(id)
          .filter((l) => l.entityType === 'task').delete()
      },
    )
  },

  history: (id: ID) => db.statusEvents.where('taskId').equals(id).sortBy('at'),

  /**
   * The only writer of sprintEvents, for the same reason move() is the only
   * writer of statusEvents: without the log there is no honest answer to what
   * was committed up front and what turned up on day six.
   */
  async setSprint(id: ID, sprintId: ID | null) {
    await db.transaction('rw', db.tasks, db.sprintEvents, async () => {
      const task = await db.tasks.get(id)
      if (!task || task.sprintId === sprintId) return
      await db.tasks.update(id, { sprintId, updatedAt: Date.now() })
      await db.sprintEvents.add({
        id: newId(), taskId: id, fromSprintId: task.sprintId, toSprintId: sprintId, at: Date.now(),
      })
    })
  },

  /**
   * Sets whichever person field the target column makes answerable, so dragging
   * a card into someone's row on the person-grouped board assigns them as
   * reviewer in a review column and as assignee everywhere else.
   */
  async setOwnerFor(taskId: ID, field: 'assigneeId' | 'reviewerId' | 'testerId', personId: ID | null) {
    const patch: Partial<Task> = { updatedAt: Date.now() }
    patch[field] = personId
    await db.tasks.update(taskId, patch)
  },
}

/** Days a task has sat where it is. Derived, never stored. */
export function daysInStatus(task: Task, now = Date.now()): number {
  return Math.floor((now - task.statusChangedAt) / 86_400_000)
}

export function isStuck(task: Task, stuckAfterDays: number | null, now = Date.now()): boolean {
  return stuckAfterDays != null && daysInStatus(task, now) >= stuckAfterDays
}

export interface ParsedQuickAdd {
  title: string
  assigneeName: string | null
  priority: Priority | null
  size: number | null
  tags: string[]
}

/**
 * Slice 1 version of the quick-add syntax: "Seed refund accounts @nadica !high ~3 #qa".
 * The full parser, with fuzzy name matching and bulk paste, lands in slice 3.
 */
export function parseQuickAdd(input: string): ParsedQuickAdd {
  const tags: string[] = []
  let assigneeName: string | null = null
  let priority: Priority | null = null
  let size: number | null = null

  const title = input
    .replace(/(^|\s)@([\w.-]+)/g, (_m, _s, n: string) => { assigneeName = n; return ' ' })
    .replace(/(^|\s)!(low|normal|high|urgent)\b/gi, (_m, _s, p: string) => { priority = p.toLowerCase() as Priority; return ' ' })
    .replace(/(^|\s)~(\d+(?:\.\d+)?)/g, (_m, _s, n: string) => { size = Number(n); return ' ' })
    .replace(/(^|\s)#([\w-]+)/g, (_m, _s, t: string) => { tags.push(t); return ' ' })
    .replace(/\s+/g, ' ')
    .trim()

  return { title, assigneeName, priority, size, tags }
}
