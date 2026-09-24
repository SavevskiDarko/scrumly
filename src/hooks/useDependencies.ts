import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'
import type { ID, Sprint, Task, TaskLink } from '../db/types'
import { DEPENDENCY_LABEL, dependencyState, links, worstState, type DependencyState } from '../repo'

export interface DepInfo {
  /** The worst of everything this task waits on. */
  state: DependencyState
  /** How many unfinished things it waits on. */
  open: number
  /** One line per dependency, for a tooltip. */
  detail: string
}

/**
 * What each task waits on, and whether it is on course to land first.
 *
 * The tasks being waited on are often another team's, which the screen asking
 * has not loaded — so they are fetched here, along with every team's sprints,
 * since the comparison is between two teams' calendars.
 */
export function useDependencies(tasks: Task[], doneIds: Set<ID>) {
  const all = useLiveQuery(() => links.all(), [], [] as TaskLink[])
  const known = new Map(tasks.map((t) => [t.id, t]))
  const relevant = all.filter((l) => known.has(l.toTaskId))
  const missing = [...new Set(relevant.map((l) => l.fromTaskId))].filter((id) => !known.has(id)).sort()
  const extra = useLiveQuery(
    async () => (missing.length ? (await db.tasks.bulkGet(missing)).filter((t): t is Task => Boolean(t)) : []),
    [missing.join(',')], [] as Task[],
  )
  const sprints = useLiveQuery(() => db.sprints.toArray(), [], [] as Sprint[])

  const taskById = new Map(known)
  for (const t of extra) taskById.set(t.id, t)
  const sprintById = new Map(sprints.map((s) => [s.id, s]))

  /** `sprintId` asks "if this task were in that sprint" — what planning needs before pulling it in. */
  return (task: Task, sprintId?: ID | null): DepInfo | null => {
    const waits = relevant.filter((l) => l.toTaskId === task.id)
    if (!waits.length) return null
    const each = waits.map((l) => {
      const blocker = taskById.get(l.fromTaskId)
      const state = dependencyState(blocker, task, sprintById, doneIds, sprintId)
      return { state, line: `${blocker?.key ?? '?'} ${blocker?.title ?? ''} — ${DEPENDENCY_LABEL[state].toLowerCase()}` }
    })
    return {
      state: worstState(each.map((e) => e.state))!,
      open: each.filter((e) => e.state !== 'done').length,
      detail: each.map((e) => e.line).join('\n'),
    }
  }
}
