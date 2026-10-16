import { db } from '../db/schema'
import type { Blocker, Chase, ID, Person, Sprint, SprintEvent, Status, StatusEvent, Task, Team } from '../db/types'
import {
  blockedDays, buildIndex, daysInStatus, describeWaitingOn, isOverdue, isStuckTask, ownerOf, pointsOf,
  settings as settingsRepo, sprintStats, todayISO, velocity, type BoardIndex,
} from '../repo'
import type { Sight } from './sight'

/*
 * The board as the assistant reads it: plain text, ISO dates, task keys and
 * people's names. Ids never appear — everything the assistant hands back is
 * matched by key or name (tools.ts), which is what it can actually see.
 */

/** Open tasks listed in full before the rest are only counted. Most of an overflow is backlog. */
const OPEN_LISTED = 150
const DONE_LISTED = 60

export interface TeamData {
  team: Team
  statuses: Status[]
  /** Active members of this team the assistant may see, by name. */
  members: Person[]
  /** Everyone it may see, for the names on older work. */
  people: Map<ID, Person>
  tasks: Task[]
  sprints: Sprint[]
  /** Open, on this team's tasks. */
  blockers: Blocker[]
  chases: Chase[]
  statusEvents: StatusEvent[]
  sprintEvents: SprintEvent[]
  ix: BoardIndex
  holidays: string[]
}

const byName = (a: Person, b: Person) => a.name.localeCompare(b.name)

export async function loadTeam(team: Team, sight: Sight): Promise<TeamData> {
  const statuses = await db.statuses.orderBy('order').toArray()
  const visiblePeople = (await db.people.toArray()).filter((p) => sight.sees('people', p.id))
  const tasks = (await db.tasks.where('teamId').equals(team.id).toArray()).filter((t) => sight.sees('tasks', t.id))
  const taskIds = tasks.map((t) => t.id)
  const onTeam = new Set(taskIds)
  const sprints = (await db.sprints.where('teamId').equals(team.id).sortBy('startDate')).filter((s) => sight.sees('sprints', s.id))
  const blockers = (await db.blockers.filter((b) => b.resolvedAt === null).toArray()).filter((b) => onTeam.has(b.taskId))
  const blockerIds = new Set(blockers.map((b) => b.id))
  const chases = (await db.chases.toArray()).filter((c) => blockerIds.has(c.blockerId))
  const statusEvents = await db.statusEvents.where('taskId').anyOf(taskIds).toArray()
  const sprintEvents = await db.sprintEvents.where('taskId').anyOf(taskIds).toArray()
  const cfg = await settingsRepo.get()

  return {
    team,
    statuses,
    members: visiblePeople.filter((p) => p.active && p.teamIds.includes(team.id)).sort(byName),
    people: new Map(visiblePeople.map((p) => [p.id, p])),
    tasks,
    sprints,
    blockers,
    chases,
    statusEvents,
    sprintEvents,
    ix: buildIndex(statuses, visiblePeople, blockers),
    holidays: cfg?.holidays ?? [],
  }
}

/** A cell of a pipe-separated line: one line, and no pipes of its own. */
export const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()

export function personName(d: TeamData, id: ID | null): string {
  if (!id) return '–'
  return d.people.get(id)?.name ?? 'someone the assistant cannot see'
}

export function sprintName(d: TeamData, id: ID | null): string {
  if (!id) return 'none'
  const s = d.sprints.find((x) => x.id === id)
  if (!s) return 'unknown'
  return s.state === 'active' ? `${s.name} (running)` : s.name
}

export function flagsOf(t: Task, d: TeamData, now: number): string[] {
  const flags: string[] = []
  if (d.ix.blockerByTask.has(t.id)) flags.push('BLOCKED')
  if (isStuckTask(t, d.ix, now)) flags.push('STUCK')
  if (isOverdue(t, d.ix, todayISO(new Date(now)))) flags.push('OVERDUE')
  if (t.jira) flags.push('jira')
  return flags
}

export const TASK_HEADER =
  'key | title | column | days in column | answerable now | assignee / reviewer / tester | priority | points | due | sprint | flags'

export function taskLine(t: Task, d: TeamData, now: number): string {
  const status = d.ix.byStatus.get(t.statusId)
  const owner = ownerOf(t, status, d.ix)
  return [
    t.key,
    cell(t.title),
    status?.name ?? '?',
    String(daysInStatus(t, now)),
    owner?.name ?? 'nobody',
    `${personName(d, t.assigneeId)} / ${personName(d, t.reviewerId)} / ${personName(d, t.testerId)}`,
    t.priority,
    t.size == null ? '–' : String(t.size),
    t.dueDate ?? '–',
    sprintName(d, t.sprintId),
    flagsOf(t, d, now).join(' ') || '–',
  ].join(' | ')
}

function columnsLine(d: TeamData): string {
  return d.statuses.map((s) => {
    const notes: string[] = []
    if (s.countsAsActive) notes.push('active work')
    if (s.isDone) notes.push('done')
    if (s.stuckAfterDays != null) notes.push(`stuck after ${s.stuckAfterDays}d`)
    if (s.wipLimit != null) notes.push(`WIP limit ${s.wipLimit}`)
    return notes.length ? `${s.name} (${notes.join(', ')})` : s.name
  }).join(' → ')
}

export function sprintSummary(s: Sprint, d: TeamData, now: number, withBurndown: boolean): string[] {
  const stats = sprintStats(s, d.tasks, d.statusEvents, d.sprintEvents, d.statuses, { now, holidays: d.holidays })
  const lines = [
    `${s.name} — ${s.state === 'active' ? 'running' : s.state}, ${s.startDate} to ${s.endDate}${s.goal ? `, goal: "${cell(s.goal)}"` : ', no goal set'}${s.jira ? ' [jira]' : ''}`,
  ]
  if (s.state === 'planned') {
    lines.push(`${stats.total} tasks in it so far, ${stats.points} points.`)
    return lines
  }
  if (s.state === 'active') lines.push(`Working day ${Math.min(stats.dayIndex, stats.dayCount)} of ${stats.dayCount}.`)
  lines.push(
    `${stats.total} tasks (${stats.committed} there at the start, ${stats.addedAfterStart} added since, ${stats.removed} taken out), `
    + `${stats.done} done. ${stats.points} points, ${stats.pointsDone} done.`,
  )
  if (withBurndown && stats.series.length) {
    const today = todayISO(new Date(now))
    const upTo = stats.series.filter((p) => p.date <= today)
    if (upTo.length) {
      lines.push(`Burndown (${stats.burndownUnit} remaining at the end of each working day, ideal in brackets): `
        + upTo.map((p) => `${p.date.slice(5)} ${p.remaining} (${p.ideal})`).join(', '))
    }
  }
  return lines
}

function blockerLine(b: Blocker, d: TeamData, now: number): string {
  const task = d.tasks.find((t) => t.id === b.taskId)
  const waitingTask = b.waitingOnTaskId ? d.tasks.find((t) => t.id === b.waitingOnTaskId) : null
  const waitingOn = describeWaitingOn(b, b.waitingOnPersonId ? personName(d, b.waitingOnPersonId) : null, waitingTask?.key ?? null)
  const chases = d.chases.filter((c) => c.blockerId === b.id).sort((a, c) => a.at - c.at)
  const last = chases[chases.length - 1]
  const chased = chases.length
    ? `chased ${chases.length}×, last ${todayISO(new Date(last.at))}${last.note ? ` ("${cell(last.note)}")` : ''}`
    : 'never chased'
  return `${task?.key ?? '?'} blocked ${blockedDays(b, now)}d: "${cell(b.reason)}" — waiting on ${waitingOn} (${b.waitingOnType}); ${chased}`
}

/** Open work, closest to done first, so an overflow cuts backlog rather than work in flight. */
export function openWork(d: TeamData): Task[] {
  const order = new Map(d.statuses.map((s) => [s.id, s.order]))
  const prio = { urgent: 0, high: 1, normal: 2, low: 3 }
  return d.tasks
    .filter((t) => !d.ix.doneIds.has(t.statusId))
    .sort((a, b) => (order.get(b.statusId) ?? 0) - (order.get(a.statusId) ?? 0)
      || prio[a.priority] - prio[b.priority]
      || b.updatedAt - a.updatedAt)
}

/**
 * Everything worth knowing about one team right now, as the assistant reads
 * it. The first message of every conversation carries this for the open team.
 */
export async function teamReport(team: Team, sight: Sight, now = Date.now()): Promise<string> {
  const d = await loadTeam(team, sight)
  const date = new Date(now)
  const today = todayISO(date)
  const out: string[] = []

  out.push(`# Scrumly — ${team.name}`)
  out.push(`Now: ${date.toLocaleDateString('en-GB', { weekday: 'long' })} ${today}, `
    + `${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. Working days are Monday to Friday.`
    + (d.holidays.some((h) => h >= today) ? ` Holidays ahead: ${d.holidays.filter((h) => h >= today).slice(0, 8).join(', ')}.` : ''))
  out.push(`Team ${team.name}, task keys ${team.keyPrefix}-n.`
    + (team.jira ? ` Follows the Jira board "${team.jira.boardName}": tasks marked jira are owned by Jira.` : '')
    + (team.localOnly ? ' Kept on this computer only; the user has allowed you to read it.' : ''))
  const others = sight.teams.filter((t) => t.id !== team.id).map((t) => t.name)
  if (others.length) out.push(`Other teams you can read: ${others.join(', ')}.`)
  if (sight.closed.length) out.push(`Teams hidden from you (kept on this computer only): ${sight.closed.map((t) => t.name).join(', ')}.`)

  out.push('', '## Columns', columnsLine(d))

  out.push('', '## People')
  if (!d.members.length) out.push('Nobody is in this team yet.')
  for (const p of d.members) {
    const active = d.tasks.filter((t) => d.ix.activeIds.has(t.statusId)
      && (ownerOf(t, d.ix.byStatus.get(t.statusId), d.ix)?.id === p.id || t.assigneeId === p.id))
    const blocked = active.filter((t) => d.ix.blockerByTask.has(t.id)).length
    out.push(`${p.name} (${p.role}) — ${active.length} task${active.length === 1 ? '' : 's'} in active work${blocked ? `, ${blocked} blocked` : ''}`)
  }

  out.push('', '## Sprints')
  const running = d.sprints.find((s) => s.state === 'active')
  if (running) out.push(...sprintSummary(running, d, now, true))
  else out.push('No sprint is running.')
  for (const s of d.sprints.filter((x) => x.state === 'planned')) out.push(...sprintSummary(s, d, now, false))
  const closed = d.sprints.filter((s) => s.state === 'closed').slice(-6)
  if (closed.length) {
    out.push('Velocity, points finished in each closed sprint: '
      + velocity(closed, d.tasks, d.statusEvents, d.statuses).map((v) => `${v.name} ${v.points} (${v.tasks} tasks)`).join(', '))
  }

  const open = openWork(d)
  out.push('', `## Open work (${open.length})`, TASK_HEADER)
  for (const t of open.slice(0, OPEN_LISTED)) out.push(taskLine(t, d, now))
  if (open.length > OPEN_LISTED) {
    out.push(`…and ${open.length - OPEN_LISTED} more, furthest from done, not listed. find_tasks searches all of them.`)
  }
  if (!open.length) out.push('Nothing open.')

  if (running) {
    const done = d.tasks.filter((t) => t.sprintId === running.id && d.ix.doneIds.has(t.statusId))
    if (done.length) {
      out.push('', `## Done in ${running.name} (${done.length})`)
      for (const t of done.slice(0, DONE_LISTED)) {
        out.push(`${t.key} ${cell(t.title)} — ${personName(d, t.assigneeId)}, ${pointsOf(t)} pts`)
      }
    }
  }

  out.push('', `## Open blockers (${d.blockers.length})`)
  for (const b of [...d.blockers].sort((a, c) => a.openedAt - c.openedAt)) out.push(blockerLine(b, d, now))
  if (!d.blockers.length) out.push('None.')

  const follow = (await db.followUps.filter((f) => f.doneAt === null).toArray())
    .filter((f) => sight.sees('followUps', f.id))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
  out.push('', `## The user's own open follow-ups (${follow.length})`)
  for (const f of follow.slice(0, 40)) {
    out.push(`- ${cell(f.title)}${f.dueDate ? ` — due ${f.dueDate}` : ''}${f.personId ? ` — about ${personName(d, f.personId)}` : ''}`)
  }
  if (!follow.length) out.push('None.')

  const standup = (await db.standups.where('teamId').equals(team.id).sortBy('startedAt')).pop()
  if (standup && sight.sees('standups', standup.id)) {
    const said = await db.standupNotes.where('standupId').equals(standup.id).toArray()
    out.push('', `## Last stand-up (${standup.date})`)
    for (const n of said) out.push(`${personName(d, n.personId)}: "${cell(n.text)}"`)
    if (!said.length) out.push('Nothing was written down.')
  }

  return out.join('\n')
}
