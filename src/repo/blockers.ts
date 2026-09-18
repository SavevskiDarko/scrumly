import { db } from '../db/schema'
import type { Blocker, ID } from '../db/types'
import { newId } from './ids'

export interface OpenBlockerInput {
  reason: string
  waitingOnType: Blocker['waitingOnType']
  waitingOnPersonId?: ID | null
  waitingOnTaskId?: ID | null
  waitingOnText?: string | null
}

export const blockers = {
  /** At most one open blocker per task — a second reason is an edit, not a new row. */
  openForTask: (taskId: ID) =>
    db.blockers.where('taskId').equals(taskId).filter((b) => b.resolvedAt === null).first(),

  listOpen: () => db.blockers.filter((b) => b.resolvedAt === null).toArray(),

  /** Scoped, so the sidebar badge counts this team's blockers rather than everyone's. */
  async openForTeam(teamId: ID) {
    const open = await db.blockers.filter((b) => b.resolvedAt === null).toArray()
    if (!open.length) return open
    const ids = new Set(await db.tasks.where('teamId').equals(teamId).primaryKeys() as ID[])
    return open.filter((b) => ids.has(b.taskId))
  },
  listResolved: () => db.blockers.filter((b) => b.resolvedAt !== null).toArray(),
  chasesFor: (blockerId: ID) => db.chases.where('blockerId').equals(blockerId).sortBy('at'),
  allChases: () => db.chases.toArray(),

  async open(taskId: ID, input: OpenBlockerInput): Promise<Blocker> {
    const existing = await blockers.openForTask(taskId)
    if (existing) {
      await db.blockers.update(existing.id, { ...input })
      return { ...existing, ...input }
    }
    const row: Blocker = {
      id: newId(),
      taskId,
      reason: input.reason.trim(),
      waitingOnType: input.waitingOnType,
      waitingOnPersonId: input.waitingOnPersonId ?? null,
      waitingOnTaskId: input.waitingOnTaskId ?? null,
      waitingOnText: input.waitingOnText?.trim() || null,
      openedAt: Date.now(),
      resolvedAt: null,
      resolutionNote: null,
    }
    await db.blockers.add(row)
    return row
  },

  async update(id: ID, patch: Partial<OpenBlockerInput>) {
    await db.blockers.update(id, patch)
  },

  /** Logging a chase is the whole point — "four days, chased twice" is what you escalate with. */
  async chase(blockerId: ID, note = '') {
    await db.chases.add({ id: newId(), blockerId, at: Date.now(), note: note.trim() })
  },

  async resolve(id: ID, note = '') {
    await db.blockers.update(id, { resolvedAt: Date.now(), resolutionNote: note.trim() || null })
  },

  async reopen(id: ID) {
    await db.blockers.update(id, { resolvedAt: null, resolutionNote: null })
  },
}

/** Days a blocker has been open, or how long it was open if it is resolved. */
export function blockedDays(b: Blocker, now = Date.now()): number {
  return Math.floor(((b.resolvedAt ?? now) - b.openedAt) / 86_400_000)
}

export interface WaitGroup {
  key: string
  label: string
  /** Days lost across every blocker in this group. */
  days: number
  count: number
  stillOpen: number
}

/**
 * Days lost, grouped by whatever the work was waiting on.
 *
 * A total on its own ("we lost twelve days") is an impression. Split by who or
 * what you were waiting for ("eight of them to one vendor") it is an argument
 * you can take to a retro, which is the whole reason resolved blockers are kept.
 */
export function groupWaitingOn(
  rows: Blocker[],
  label: (b: Blocker) => string,
  now = Date.now(),
): WaitGroup[] {
  const groups = new Map<string, WaitGroup>()
  for (const b of rows) {
    // Free text is grouped case-insensitively, so "Vendor" and "vendor" are one
    // line rather than two halves of the same problem.
    const id = b.waitingOnPersonId ?? b.waitingOnTaskId ?? (b.waitingOnText ?? '').trim().toLowerCase()
    const key = `${b.waitingOnType}:${id}`
    const cur = groups.get(key)
    const days = blockedDays(b, now)
    if (cur) {
      cur.days += days
      cur.count++
      if (b.resolvedAt === null) cur.stillOpen++
    } else {
      groups.set(key, {
        key, label: label(b), days, count: 1, stillOpen: b.resolvedAt === null ? 1 : 0,
      })
    }
  }
  return [...groups.values()].sort((a, b) => b.days - a.days || b.count - a.count)
}

export function describeWaitingOn(
  b: Blocker,
  personName?: string | null,
  taskKey?: string | null,
): string {
  switch (b.waitingOnType) {
    case 'person': return personName ?? 'Someone'
    case 'task': return taskKey ? `Task ${taskKey}` : 'Another task'
    case 'team': return b.waitingOnText || 'Another team'
    case 'external': return b.waitingOnText || 'Something outside the team'
  }
}
