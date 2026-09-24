import { db } from '../db/schema'
import type { ID, JiraLink, Person, Priority, Sprint, SprintEvent, Status, StatusEvent, Task } from '../db/types'
import { hashSeed, initialsOf } from './ids'
import { todayISO } from './insights'
import { addDays } from './sprints'
import { tasks as taskRepo } from './tasks'

/*
 * Jira -> Scrumly, one way.
 *
 * Jira owns everything it knows about: sprints, and each issue's title, status,
 * sprint, assignee, size, due date and labels. A pull overwrites those. What
 * Jira has no field for — reviewer, tester, blockers, dependencies, notes — is
 * Scrumly's own and is never touched.
 *
 * The history is the point. Burndown, velocity, cycle time and board KPIs are
 * all replayed from statusEvents and sprintEvents, so an import that copied
 * only the current state would chart every Jira sprint as a flat line. Each
 * issue's changelog is replayed into those two tables instead.
 *
 * Every row gets an id derived from Jira's, so pulling twice — or from two
 * desktops — produces the same rows rather than duplicates, and the writer
 * only touches rows that actually differ, so an unchanged board syncs nothing.
 */

// ---------- what Jira sends (only the parts read here) ----------

export interface JiraSprint {
  id: number
  state: 'active' | 'future' | 'closed'
  name: string
  startDate?: string
  endDate?: string
  completeDate?: string
  goal?: string
  originBoardId?: number
}

export interface JiraUser { accountId?: string; key?: string; name?: string; displayName?: string }
export interface JiraStatus { id: string; name: string; statusCategory?: { key?: string } }
export interface JiraChangeItem { field: string; fieldId?: string; from: string | null; to: string | null }
export interface JiraHistory { id: string; created: string; items: JiraChangeItem[] }

export interface JiraIssue {
  id: string
  key: string
  fields: {
    summary?: string
    description?: unknown
    status?: JiraStatus
    assignee?: JiraUser | null
    priority?: { name?: string } | null
    duedate?: string | null
    labels?: string[]
    created?: string
    updated?: string
    /** Agile API only: the active or future sprint the issue sits in. */
    sprint?: { id: number } | null
    /** Agile API only: every closed sprint the issue was in. */
    closedSprints?: { id: number }[] | null
    [field: string]: unknown
  }
  changelog?: { total?: number; histories: JiraHistory[] }
}

export interface JiraBoard {
  id: number
  name: string
  type?: string
  location?: { projectKey?: string; displayName?: string; projectName?: string }
}

export interface JiraBoardConfig {
  columnConfig?: { columns: { name: string; statuses: { id: string }[] }[] }
  estimation?: { type?: string; field?: { fieldId: string; displayName?: string } }
}

/** Everything one pull fetched. */
export interface JiraPull {
  /** In scope this time: active, future, and the most recent closed sprints. */
  sprints: JiraSprint[]
  /** Everything in those sprints (and the backlog, if the link asks for it), in rank order. */
  issues: JiraIssue[]
  /** Every status on the site, for names and categories. */
  statuses: JiraStatus[]
  config: JiraBoardConfig
  /**
   * Issues fetched one at a time because they left a sprint that was pulled.
   * A null issue means Jira no longer has it.
   */
  rechecked: { id: string; issue: JiraIssue | null }[]
}

/** How many closed sprints to keep current. Velocity and the capacity forecast read six. */
export const CLOSED_SPRINTS_KEPT = 8

// ---------- ids ----------

export const jiraSprintId = (teamId: ID, sprintId: number | string) => `jira-${teamId}-s${sprintId}`
export const jiraTaskId = (teamId: ID, issueId: string) => `jira-${teamId}-i${issueId}`
export const jiraPersonId = (userId: string) => `jira-u-${userId.replace(/[^\w.-]/g, '_')}`
const jiraUserId = (u: JiraUser | null | undefined): string | null => (u ? u.accountId ?? u.key ?? u.name ?? null : null)

// ---------- small translations ----------

/**
 * Jira writes offsets as +0100. Browsers are not required to read that, so it
 * becomes +01:00 first.
 */
export function jiraTime(value: string | undefined | null): number | null {
  if (!value) return null
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(ms) ? null : ms
}

const jiraDay = (value: string | undefined | null): string | null => {
  const ms = jiraTime(value)
  return ms == null ? null : todayISO(new Date(ms))
}

export function priorityFrom(name: string | null | undefined): Priority {
  const n = (name ?? '').toLowerCase()
  if (/highest|blocker|critical|urgent/.test(n)) return 'urgent'
  if (/high|major/.test(n)) return 'high'
  if (/low|minor|trivial/.test(n)) return 'low'
  return 'normal'
}

/** Descriptions come as plain text from Server and as a document tree (ADF) from some Cloud endpoints. */
export function plainText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const out: string[] = []
  const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableRow'])
  const walk = (node: { type?: string; text?: string; content?: unknown[] }) => {
    if (node.type === 'text' && node.text) out.push(node.text)
    if (node.type === 'hardBreak') out.push('\n')
    if (Array.isArray(node.content)) node.content.forEach((c) => walk(c as typeof node))
    if (node.type && BLOCKS.has(node.type)) out.push('\n')
  }
  walk(value as { content?: unknown[] })
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

const splitIds = (v: string | null | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// ---------- statuses -> columns ----------

/**
 * Which Scrumly column a Jira status lands in when nobody has said. Same name
 * first, then the name of the board column the status sits under, then Jira's
 * own category: done to the first done column, in progress to the first
 * active one, and to do to the first column that is neither — skipping the
 * very first, which is the backlog.
 */
export function autoColumn(status: JiraStatus | undefined, columns: Status[], config: JiraBoardConfig): Status | null {
  if (!columns.length) return null
  const named = (name: string | undefined) =>
    name ? columns.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()) : undefined
  if (status) {
    const exact = named(status.name)
    if (exact) return exact
    const boardColumn = config.columnConfig?.columns.find((c) => c.statuses.some((s) => s.id === status.id))
    const viaBoard = named(boardColumn?.name)
    if (viaBoard) return viaBoard
  }
  const category = status?.statusCategory?.key
  if (category === 'done') return columns.find((c) => c.isDone) ?? columns[columns.length - 1]
  if (category === 'indeterminate') return columns.find((c) => c.countsAsActive) ?? columns[0]
  return columns.find((c, i) => i > 0 && !c.isDone && !c.countsAsActive) ?? columns[0]
}

export function columnFor(
  statusId: string | null | undefined, link: Pick<JiraLink, 'statusMap'>, known: Map<string, JiraStatus>,
  columns: Status[], config: JiraBoardConfig,
): ID {
  const manual = statusId ? link.statusMap[statusId] : undefined
  if (manual && columns.some((c) => c.id === manual)) return manual
  return (autoColumn(statusId ? known.get(statusId) : undefined, columns, config) ?? columns[0]).id
}

// ---------- planning ----------

export interface LocalState {
  teamId: ID
  link: JiraLink
  columns: Status[]
  /** Everybody, not just this team: an assignee may already exist elsewhere. */
  people: Person[]
  /** This team's tasks. */
  tasks: Task[]
  /** This team's sprints. */
  sprints: Sprint[]
  sprintLengthDays: number
  now: number
}

export interface ImportPlan {
  sprints: Sprint[]
  people: Person[]
  tasks: Task[]
  /** The complete history for every task in `tasks`; anything else on record for them goes. */
  statusEvents: StatusEvent[]
  sprintEvents: SprintEvent[]
  removeTaskIds: ID[]
}

interface SprintFacts { localId: ID; closedAt: number | null }

export function planImport(pull: JiraPull, local: LocalState): ImportPlan {
  const { teamId, link, columns, now } = local
  const statusById = new Map(pull.statuses.map((s) => [s.id, s]))
  for (const issue of pull.issues) {
    const s = issue.fields.status
    if (s && !statusById.has(s.id)) statusById.set(s.id, s)
  }
  const col = (statusId: string | null | undefined) => columnFor(statusId, link, statusById, columns, pull.config)
  const doneColumns = new Set(columns.filter((c) => c.isDone).map((c) => c.id))

  // ----- sprints -----
  const sprintRows: Sprint[] = []
  let previousEnd: string | null = null
  for (const js of pull.sprints) {
    // A future sprint often has no dates yet: it follows the one before, for a
    // sprint's usual length, until Jira says otherwise.
    const start: string = jiraDay(js.startDate) ?? (previousEnd ? addDays(previousEnd, 1) : todayISO(new Date(now)))
    let end: string = jiraDay(js.endDate) ?? addDays(start, Math.max(1, local.sprintLengthDays) - 1)
    if (end < start) end = start
    previousEnd = end
    sprintRows.push({
      id: jiraSprintId(teamId, js.id),
      teamId,
      name: js.name,
      goal: js.goal ?? '',
      startDate: start,
      endDate: end,
      state: js.state === 'future' ? 'planned' : js.state,
      closedAt: js.state === 'closed' ? jiraTime(js.completeDate) ?? jiraTime(js.endDate) ?? now : null,
      jira: { id: js.id },
    })
  }

  // What is known about every Jira sprint this team has ever imported, not
  // just the ones pulled today: an issue's history can reach back further.
  const sprintFacts = new Map<string, SprintFacts>()
  for (const s of local.sprints) if (s.jira) sprintFacts.set(String(s.jira.id), { localId: s.id, closedAt: s.closedAt })
  for (const s of sprintRows) sprintFacts.set(String(s.jira!.id), { localId: s.id, closedAt: s.closedAt })

  /**
   * The sprint an issue counted as being in, at a moment. Jira's Sprint field
   * lists every sprint an issue has been in, newest last, and keeps closed ones
   * — so an issue carried from A into B reads "A, B", and one then dropped back
   * to the backlog reads "A". The newest listed sprint that had not yet closed
   * is the one it was in; none means the backlog.
   */
  const inSprintAt = (ids: string[], at: number): string | null => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const facts = sprintFacts.get(ids[i])
      if (!facts) continue
      if ((facts.closedAt ?? Infinity) > at) return ids[i]
    }
    return null
  }
  const localSprint = (jiraId: string | null) => (jiraId ? sprintFacts.get(jiraId)?.localId ?? null : null)

  // ----- people -----
  const peopleOut = new Map<ID, Person>()
  const byJiraId = new Map(local.people.filter((p) => p.jiraId).map((p) => [p.jiraId!, p]))
  // Someone matched to one Jira user is never matched to a second by name:
  // two people called Alex are two people.
  const claimed = new Set(local.people.filter((p) => p.jiraId).map((p) => p.id))
  const earliestStart = sprintRows.reduce<number | null>((min, s) => {
    const t = new Date(`${s.startDate}T00:00:00`).getTime()
    return min == null || t < min ? t : min
  }, null)

  const personFor = (user: JiraUser | null | undefined): ID | null => {
    const uid = jiraUserId(user)
    if (!uid) return null
    const name = user?.displayName?.trim() || uid
    // Already matched once; or someone with the same name, preferring this team's.
    const lower = name.toLowerCase()
    const sameName = (p: Person) => !claimed.has(p.id) && p.name.trim().toLowerCase() === lower
    const known = byJiraId.get(uid)
      ?? local.people.find((p) => p.teamIds.includes(teamId) && sameName(p))
      ?? local.people.find(sameName)
    if (known) {
      const base = peopleOut.get(known.id) ?? known
      const next = { ...base, jiraId: uid, teamIds: base.teamIds.includes(teamId) ? base.teamIds : [...base.teamIds, teamId] }
      peopleOut.set(known.id, next)
      byJiraId.set(uid, next)
      claimed.add(known.id)
      return known.id
    }
    const id = jiraPersonId(uid)
    const row: Person = {
      id, name, role: 'Developer', initials: initialsOf(name), colorSeed: hashSeed(name),
      skills: [], notes: '', active: true, teamIds: [teamId],
      // Around for every sprint pulled, so board KPIs count those sprints as theirs.
      createdAt: earliestStart ?? now,
      jiraId: uid,
    }
    peopleOut.set(id, row)
    byJiraId.set(uid, row)
    claimed.add(id)
    return id
  }

  // ----- issues -----
  const existingById = new Map(local.tasks.map((t) => [t.id, t]))
  const tasksOut: Task[] = []
  const statusEvents: StatusEvent[] = []
  const sprintEvents: SprintEvent[] = []
  const removeTaskIds: ID[] = []
  const pointsField = pull.config.estimation?.field?.fieldId ?? null

  const add = (issue: JiraIssue, order: number | null) => {
    const f = issue.fields
    const id = jiraTaskId(teamId, issue.id)
    const existing = existingById.get(id)
    const created = jiraTime(f.created) ?? now
    const updated = jiraTime(f.updated) ?? created
    const histories = [...(issue.changelog?.histories ?? [])]
      .map((h) => ({ ...h, at: jiraTime(h.created) ?? created }))
      .sort((a, b) => a.at - b.at || Number(a.id) - Number(b.id))

    // Sprint membership over time.
    const sprintChanges = histories.flatMap((h) => h.items
      .filter((it) => it.field.toLowerCase() === 'sprint')
      .map((it) => ({ at: h.at, hid: h.id, before: splitIds(it.from), after: splitIds(it.to) })))
    const fromFields = [
      ...(f.closedSprints ?? []).map((s) => String(s.id)),
      ...(f.sprint ? [String(f.sprint.id)] : []),
    ]
    const initialList = sprintChanges.length ? sprintChanges[0].before : fromFields
    const listAt = (at: number) => {
      let list = initialList
      for (const c of sprintChanges) { if (c.at <= at) list = c.after; else break }
      return list
    }
    const sprintAt = (at: number) => localSprint(inSprintAt(listAt(at), at))

    // Status history, as moves between Scrumly columns. Two Jira statuses in
    // one column are one place as far as the board is concerned, so a move
    // between them is not a move.
    const statusChanges = histories.flatMap((h) => h.items
      .filter((it) => (it.fieldId ?? it.field).toLowerCase() === 'status')
      .map((it, i) => ({ at: h.at, eid: `h${h.id}-${i}`, from: it.from, to: it.to })))
    const events: StatusEvent[] = []
    let column = col(statusChanges[0]?.from ?? f.status?.id)
    events.push({ id: `${id}-c`, taskId: id, fromStatusId: null, toStatusId: column, at: created, sprintIdAtTime: sprintAt(created) })
    for (const c of statusChanges) {
      const to = col(c.to)
      if (to === column) continue
      events.push({ id: `${id}-${c.eid}`, taskId: id, fromStatusId: column, toStatusId: to, at: c.at, sprintIdAtTime: sprintAt(c.at) })
      column = to
    }
    // A changelog cut short, or a mapping changed since, can leave the replay
    // somewhere other than where the issue is now. Where it is now wins.
    const current = col(f.status?.id)
    if (current !== column) {
      events.push({ id: `${id}-now`, taskId: id, fromStatusId: column, toStatusId: current, at: updated, sprintIdAtTime: sprintAt(updated) })
      column = current
    }
    statusEvents.push(...events)

    let inSprint = sprintAt(created)
    for (const c of sprintChanges) {
      const next = localSprint(inSprintAt(c.after, c.at))
      if (next === inSprint) continue
      sprintEvents.push({ id: `${id}-sp${c.hid}`, taskId: id, fromSprintId: inSprint, toSprintId: next, at: c.at })
      inSprint = next
    }

    // Where it sits now. Finished work stays in the sprint it finished in,
    // even though that sprint has closed — same as Scrumly's own close.
    const isDone = doneColumns.has(column)
    const finalList = sprintChanges.length ? sprintChanges[sprintChanges.length - 1].after : fromFields
    let sprintNow = f.sprint && sprintFacts.has(String(f.sprint.id)) ? String(f.sprint.id) : inSprintAt(finalList, now)
    if (!sprintNow && isDone) sprintNow = [...finalList].reverse().find((sid) => sprintFacts.has(sid)) ?? null

    const last = events[events.length - 1]
    const points = pointsField ? f[pointsField] : null
    tasksOut.push({
      id,
      key: issue.key,
      teamId,
      sprintId: localSprint(sprintNow),
      title: f.summary?.trim() || issue.key,
      description: plainText(f.description),
      assigneeId: personFor(f.assignee),
      reviewerId: existing?.reviewerId ?? null,
      testerId: existing?.testerId ?? null,
      statusId: column,
      priority: priorityFrom(f.priority?.name),
      size: typeof points === 'number' && Number.isFinite(points) ? points : null,
      dueDate: f.duedate ?? null,
      project: existing?.project ?? null,
      tags: f.labels ?? [],
      orderInColumn: order ?? existing?.orderInColumn ?? 0,
      createdAt: created,
      updatedAt: updated,
      statusChangedAt: last.at,
      closedAt: isDone ? last.at : null,
      jira: { id: issue.id, key: issue.key },
    })
  }

  const seen = new Set<string>()
  pull.issues.forEach((issue) => {
    if (seen.has(issue.id)) return
    seen.add(issue.id)
    add(issue, (seen.size) * 1024)
  })
  for (const r of pull.rechecked) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (r.issue) add(r.issue, null)
    else removeTaskIds.push(jiraTaskId(teamId, r.id))
  }

  return { sprints: sprintRows, people: [...peopleOut.values()], tasks: tasksOut, statusEvents, sprintEvents, removeTaskIds }
}

/**
 * Imported tasks worth asking Jira about one by one: they were in a sprint
 * this pull fetched (or in the backlog, when that was fetched too) and did not
 * come back with it. Moved to the backlog, moved to another board, or deleted.
 */
export function tasksToRecheck(
  teamTasks: Task[], seenIssueIds: Set<string>, pulledSprintIds: Set<ID>, includeBacklog: boolean, limit = 100,
): Task[] {
  return teamTasks
    .filter((t) => t.jira && !seenIssueIds.has(t.jira.id))
    .filter((t) => (t.sprintId ? pulledSprintIds.has(t.sprintId) : includeBacklog))
    .slice(0, limit)
}

// ---------- writing ----------

/** Deep equality for rows, ignoring key order and undefined properties. */
function sameRow(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => sameRow(ra[k], rb[k]))
}

export interface ImportResult { written: number; deleted: number; removedTasks: number }

/**
 * Writes a plan, touching only rows that differ from what is stored. Sync and
 * the desktop file both react to every write, so a pull of an unchanged board
 * has to write nothing at all rather than the same thing again.
 */
export async function applyImport(plan: ImportPlan): Promise<ImportResult> {
  const tables = [db.sprints, db.people, db.tasks, db.statusEvents, db.sprintEvents,
    db.taskLinks, db.externalLinks, db.blockers, db.chases, db.conversions, db.boardLinks]
  return db.transaction('rw', tables, async () => {
    let written = 0
    let deleted = 0

    async function put<T extends { id: ID }>(table: { bulkGet(k: ID[]): Promise<(T | undefined)[]>; bulkPut(r: T[]): Promise<unknown> }, rows: T[]) {
      if (!rows.length) return
      const stored = await table.bulkGet(rows.map((r) => r.id))
      const changed = rows.filter((r, i) => !sameRow(stored[i], r))
      if (changed.length) await table.bulkPut(changed)
      written += changed.length
    }

    await put(db.sprints, plan.sprints)
    await put(db.people, plan.people)
    await put(db.tasks, plan.tasks)

    // An imported task's history is Jira's changelog, so whatever is on
    // record for it and not in the replay goes — including a move made here.
    const taskIds = plan.tasks.map((t) => t.id)
    if (taskIds.length) {
      const keepStatus = new Set(plan.statusEvents.map((e) => e.id))
      const staleStatus = (await db.statusEvents.where('taskId').anyOf(taskIds).primaryKeys() as ID[])
        .filter((k) => !keepStatus.has(k))
      const keepSprint = new Set(plan.sprintEvents.map((e) => e.id))
      const staleSprint = (await db.sprintEvents.where('taskId').anyOf(taskIds).primaryKeys() as ID[])
        .filter((k) => !keepSprint.has(k))
      await db.statusEvents.bulkDelete(staleStatus)
      await db.sprintEvents.bulkDelete(staleSprint)
      deleted += staleStatus.length + staleSprint.length
    }
    await put(db.statusEvents, plan.statusEvents)
    await put(db.sprintEvents, plan.sprintEvents)

    let removedTasks = 0
    for (const id of plan.removeTaskIds) {
      if (!(await db.tasks.get(id))) continue
      await taskRepo.remove(id)
      removedTasks++
    }
    return { written, deleted, removedTasks }
  })
}

// ---------- the link ----------

export const jiraLinks = {
  async link(teamId: ID, input: { site: string; boardId: number; boardName: string }) {
    const link: JiraLink = {
      site: input.site, boardId: input.boardId, boardName: input.boardName,
      statusMap: {}, includeBacklog: false, auto: true, lastPull: null,
    }
    await db.teams.update(teamId, { jira: link })
  },

  async update(teamId: ID, patch: Partial<Pick<JiraLink, 'statusMap' | 'includeBacklog' | 'auto' | 'lastPull'>>) {
    const team = await db.teams.get(teamId)
    if (!team?.jira) return
    await db.teams.update(teamId, { jira: { ...team.jira, ...patch } })
  },

  /** Sets one status by hand, or with null puts it back to automatic. */
  async mapStatus(teamId: ID, jiraStatusId: string, columnId: ID | null) {
    const team = await db.teams.get(teamId)
    if (!team?.jira) return
    const statusMap = { ...team.jira.statusMap }
    if (columnId) statusMap[jiraStatusId] = columnId
    else delete statusMap[jiraStatusId]
    await jiraLinks.update(teamId, { statusMap })
  },

  /** Stops pulling. What was imported stays, and linking the same board again picks it back up. */
  async unlink(teamId: ID) {
    // Undefined in update() is Dexie for "remove this property".
    await db.teams.update(teamId, { jira: undefined })
  },
}
