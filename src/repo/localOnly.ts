import { db } from '../db/schema'
import type {
  Availability, Blocker, BoardLink, Chase, Conversion, ExternalLink, FollowUp, ID, Kpi, KpiEntry, Note, Person,
  PiObjective, PiVote, Sprint, SprintEvent, Standup, StandupNote, StatusEvent, Task, TaskLink, Team,
} from '../db/types'

/*
 * Kept on this computer only.
 *
 * A team can be marked to stay on the computer it is on — a work laptop
 * following a company's Jira board, say. That team and everything that hangs
 * off it are left out of every copy that could leave: sync, exported backups,
 * and the desktop data folder, which may sit in OneDrive or a git repo. The
 * desktop app keeps them in a file of their own under its app data instead.
 *
 * What "hangs off it" means is decided here and nowhere else, so sync, backups
 * and the data file can never disagree about what stays behind. Settings,
 * canvases, processes and program increments are nobody's team's, and always
 * travel.
 */

export type TableRows = Partial<Record<string, readonly unknown[]>>

export interface LocalScope {
  /** Nothing is kept back, and every copy is the whole database — as before this existed. */
  readonly empty: boolean
  has(table: string, id: string | number): boolean
  /** The ids kept back in one table. */
  ids(table: string): ReadonlySet<string>
  /** Every row kept back, as [table, id]. */
  keys(): [string, string][]
}

/** The tables the rules below read, in the order they need them. */
const SCOPED_TABLES = [
  'teams', 'people', 'sprints', 'tasks', 'statusEvents', 'sprintEvents', 'externalLinks', 'taskLinks',
  'blockers', 'chases', 'availability', 'standups', 'standupNotes', 'piObjectives', 'piVotes',
  'notes', 'followUps', 'conversions', 'boardLinks', 'kpis', 'kpiEntries',
] as const

const NONE: ReadonlySet<string> = new Set()

function scope(kept: Map<string, Set<string>>): LocalScope {
  return {
    empty: kept.size === 0,
    has: (table, id) => kept.get(table)?.has(String(id)) ?? false,
    ids: (table) => kept.get(table) ?? NONE,
    keys: () => [...kept].flatMap(([table, ids]) => [...ids].map((id): [string, string] => [table, id])),
  }
}

const NOTHING = scope(new Map())

/** Works out what stays on this computer from a set of rows — a snapshot's, or the database's. */
export function scopeOf(tables: TableRows): LocalScope {
  const kept = new Map<string, Set<string>>()
  const take = <T extends { id: ID }>(table: string, keep: (row: T) => boolean): Set<string> => {
    const ids = new Set<string>()
    for (const row of (tables[table] ?? []) as readonly T[]) if (keep(row)) ids.add(row.id)
    if (ids.size) kept.set(table, ids)
    return ids
  }
  const within = (ids: Set<string>, id: ID | null | undefined) => id != null && ids.has(id)

  const teams = take<Team>('teams', (t) => t.localOnly === true)
  if (!teams.size) return NOTHING

  // Someone who is also on a team that travels belongs to that team as well,
  // and travels with it. Only people whose every team stays here stay too.
  const people = take<Person>('people', (p) => (p.teamIds ?? []).length > 0 && p.teamIds.every((id) => teams.has(id)))
  const sprints = take<Sprint>('sprints', (s) => teams.has(s.teamId))
  const tasks = take<Task>('tasks', (t) => teams.has(t.teamId))

  const onTask = (row: { taskId: ID }) => tasks.has(row.taskId)
  take<StatusEvent>('statusEvents', onTask)
  take<SprintEvent>('sprintEvents', onTask)
  take<ExternalLink>('externalLinks', onTask)
  // Either end: a dependency whose other task is missing points at nothing.
  take<TaskLink>('taskLinks', (l) => tasks.has(l.fromTaskId) || tasks.has(l.toTaskId))
  const blockers = take<Blocker>('blockers', onTask)
  take<Chase>('chases', (c) => blockers.has(c.blockerId))
  take<Availability>('availability', (a) => sprints.has(a.sprintId) || people.has(a.personId))

  const inTeam = (row: { teamId: ID }) => teams.has(row.teamId)
  take<Standup>('standups', inTeam)
  take<StandupNote>('standupNotes', inTeam)
  take<PiObjective>('piObjectives', inTeam)
  take<PiVote>('piVotes', inTeam)

  const notes = take<Note>('notes', (n) => within(teams, n.teamId) || within(sprints, n.sprintId) || within(people, n.personId))
  const followUps = take<FollowUp>('followUps',
    (f) => within(sprints, f.sprintId) || within(people, f.personId) || within(notes, f.sourceNoteId))
  take<Conversion>('conversions', (c) => notes.has(c.noteId) || tasks.has(c.createdId) || followUps.has(c.createdId))
  take<BoardLink>('boardLinks', (l) => (l.entityType === 'task' && tasks.has(l.entityId))
    || (l.entityType === 'sprint' && sprints.has(l.entityId))
    || (l.entityType === 'team' && teams.has(l.entityId)))

  const kpis = take<Kpi>('kpis', (k) => people.has(k.personId))
  take<KpiEntry>('kpiEntries', (e) => kpis.has(e.kpiId))

  return scope(kept)
}

/**
 * What stays on this computer as the database has it now, judged together
 * with `incoming` — rows about to be written — when there are any. One read of
 * the teams and nothing more for every install where no team has been marked.
 */
export async function currentScope(incoming: TableRows = {}): Promise<LocalScope> {
  const teams = [...await db.teams.toArray(), ...(incoming.teams ?? []) as Team[]]
  if (!teams.some((t) => t.localOnly === true)) return NOTHING
  const tables: Record<string, unknown[]> = { teams }
  for (const name of SCOPED_TABLES) {
    if (name !== 'teams') tables[name] = [...await db.table(name).toArray(), ...(incoming[name] ?? [])]
  }
  return scopeOf(tables)
}

/**
 * Empties a table except for what stays on this computer. For a restore, or
 * taking the synced copy: whatever replaces the rest never holds these rows,
 * so clearing them would lose them. Runs inside the caller's transaction.
 */
export async function clearExcept(table: string, keep: LocalScope): Promise<void> {
  const kept = keep.ids(table)
  if (!kept.size) return db.table(table).clear()
  const doomed = (await db.table(table).toCollection().primaryKeys()).filter((k) => !kept.has(String(k)))
  await db.table(table).bulkDelete(doomed)
}
