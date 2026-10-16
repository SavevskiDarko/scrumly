import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/schema'
import type { Blocker, ID, NoteType, Person, Priority, Sprint, Status, Task, Team } from '../db/types'
import { formatDate } from '../lib/dates'
import {
  actionOutcomes, blockedDays, blockers as blockerRepo, describeWaitingOn, followUps as followUpRepo, groupWaitingOn,
  isOverdue, isStuckTask, isUnowned, notes as noteRepo, sprints as sprintRepo, tasks as taskRepo, todayISO,
} from '../repo'
import {
  cell, loadTeam, personName, sprintName, sprintSummary, TASK_HEADER, taskLine, teamReport, type TeamData,
} from './context'
import { readableNote, sight, type Sight } from './sight'

/*
 * What the assistant can do, and the one rule about it: nothing here changes
 * Scrumly on its own. Reading tools answer straight away. Every other tool
 * comes back as a proposal — a sentence, the changes line by line, and an
 * apply() — which the panel puts in front of the user with Apply and Skip.
 * Only Apply calls it, and only through the repo layer, like any screen.
 *
 * Everything is matched by what the assistant can see: task keys, people's
 * and columns' names. Anything hidden from it (sight.ts) is simply not found.
 */

export interface Proposal {
  /** What will happen, in one line. */
  title: string
  /** The changes, one per line. */
  lines: string[]
  /** Longer text the change carries, such as a note's body. */
  body?: string
  /** Makes the change. Resolves with what to tell Claude; throws if it could not. */
  apply(): Promise<string>
}

export type ToolOutcome =
  /** `note`: a line for the panel saying what was looked at. */
  | { kind: 'result'; text: string; error?: boolean; note?: string }
  | { kind: 'proposal'; proposal: Proposal }

export interface ToolContext {
  /** The team open in Scrumly: the default wherever a tool's team is left out. */
  activeTeamId: ID
}

/** A mistake in what the assistant asked for. Goes back to it as an error result, so it can correct itself. */
class ToolError extends Error {}

type Args = Record<string, unknown>
interface World { sight: Sight; activeTeamId: ID }

// ---------- reading the input ----------

function argsOf(input: unknown): Args {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolError('The input must be an object')
  return input as Args
}

function text(a: Args, key: string): string | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolError(`${key} must be text`)
  return v.trim()
}

function required(a: Args, key: string): string {
  const v = text(a, key)
  if (!v) throw new ToolError(`${key} is required`)
  return v
}

const CLEARS = new Set(['', 'none', 'nobody', 'no one', 'null', '-', '–'])

/** Absent: leave it alone. Null: clear it. Text: set it. */
function nullable(a: Args, key: string): string | null | undefined {
  if (!(key in a) || a[key] === undefined) return undefined
  if (a[key] === null) return null
  const v = text(a, key)!
  return CLEARS.has(v.toLowerCase()) ? null : v
}

function num(a: Args, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const v = a[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new ToolError(`${key} must be a number`)
  if (opts.min !== undefined && n < opts.min) throw new ToolError(`${key} must be at least ${opts.min}`)
  return opts.max !== undefined ? Math.min(n, opts.max) : n
}

function bool(a: Args, key: string): boolean {
  const v = a[key]
  return v === true || v === 'true'
}

function oneOf<T extends string>(a: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = text(a, key)
  if (!v) return undefined
  const hit = allowed.find((x) => x.toLowerCase() === v.toLowerCase())
  if (!hit) throw new ToolError(`${key} must be one of: ${allowed.join(', ')}`)
  return hit
}

function isoDate(v: string, key: string): string {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw new ToolError(`${key} must be a real date written YYYY-MM-DD`)
  }
  return v
}

function tagsOf(a: Args, key: string): string[] | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null
  if (!list || list.some((x) => typeof x !== 'string')) throw new ToolError(`${key} must be a list of words`)
  return [...new Set((list as string[]).map((x) => x.trim()).filter(Boolean))]
}

// ---------- finding things by name ----------

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim()

/** Exact name first, then the start of a name, then anywhere in it — and only ever one answer. */
function pick<T>(items: T[], name: string, nameOf: (x: T) => string, what: string, where: string): T {
  const n = norm(name)
  for (const test of [
    (x: T) => norm(nameOf(x)) === n,
    (x: T) => norm(nameOf(x)).startsWith(n) || norm(nameOf(x)).split(' ').some((w) => w === n),
    (x: T) => norm(nameOf(x)).includes(n),
  ]) {
    const hits = items.filter(test)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) {
      throw new ToolError(`"${name}" could be ${hits.slice(0, 8).map(nameOf).join(', ')} — say which ${what}`)
    }
  }
  const known = items.slice(0, 15).map(nameOf).join(', ')
  throw new ToolError(`No ${what} called "${name}" ${where}${known ? `. There is: ${known}` : ''}`)
}

function teamFor(w: World, name: string | undefined): Team {
  if (!name) {
    const open = w.sight.teams.find((t) => t.id === w.activeTeamId)
    if (open) return open
    const kept = w.sight.closed.find((t) => t.id === w.activeTeamId)
    throw new ToolError(kept
      ? `${kept.name} is kept on this computer only and has not been shared with you — name another team`
      : 'No team is open — name one')
  }
  const closed = w.sight.closed.find((t) => norm(t.name) === norm(name))
  if (closed) throw new ToolError(`${closed.name} is kept on this computer only and has not been shared with you`)
  return pick(w.sight.teams, name, (t) => t.name, 'team', 'that you can see')
}

async function taskFor(w: World, key: string): Promise<Task> {
  const found = (await db.tasks.where('key').equals(key.trim().toUpperCase()).toArray())
    .filter((t) => w.sight.sees('tasks', t.id))
  if (found.length === 1) return found[0]
  if (found.length > 1) {
    const open = found.find((t) => t.teamId === w.activeTeamId)
    if (open) return open
    throw new ToolError(`More than one team has a task ${key.toUpperCase()} — use read_team on the right team first`)
  }
  throw new ToolError(`No task ${key.toUpperCase()} that you can see`)
}

function personFor(d: TeamData, name: string): Person {
  try {
    return pick(d.members, name, (p) => p.name, 'person', `in ${d.team.name}`)
  } catch (err) {
    // Somebody outside the team can still be named — a reviewer from next door —
    // but only when the team itself has nobody by that name.
    const outside = [...d.people.values()].filter((p) => p.active && !d.members.includes(p))
    const n = norm(name)
    const hit = outside.filter((p) => norm(p.name) === n || norm(p.name).split(' ')[0] === n)
    if (hit.length === 1) return hit[0]
    throw err
  }
}

/** Absent: leave it. Null: nobody. */
function personOrNobody(d: TeamData, a: Args, key: string): ID | null | undefined {
  const v = nullable(a, key)
  if (v === undefined || v === null) return v
  return personFor(d, v).id
}

function columnFor(d: TeamData, name: string): Status {
  return pick(d.statuses, name, (s) => s.name, 'column', 'on the board')
}

/** 'running', 'next', 'last', 'none' or a sprint's name. Null means no sprint. */
function sprintFor(d: TeamData, name: string): Sprint | null {
  const n = norm(name)
  if (['none', 'no sprint', 'backlog', 'remove', 'out'].includes(n)) return null
  if (['running', 'active', 'current', 'this', 'this sprint', 'the running sprint'].includes(n)) {
    const s = d.sprints.find((x) => x.state === 'active')
    if (!s) throw new ToolError(`${d.team.name} has no sprint running`)
    return s
  }
  if (['next', 'next sprint', 'planned'].includes(n)) {
    const s = d.sprints.find((x) => x.state === 'planned')
    if (!s) throw new ToolError(`${d.team.name} has no planned sprint — the user can plan one on the Sprints screen`)
    return s
  }
  if (['last', 'previous', 'last sprint', 'previous sprint'].includes(n)) {
    const s = d.sprints.filter((x) => x.state === 'closed').pop()
    if (!s) throw new ToolError(`${d.team.name} has not closed a sprint yet`)
    return s
  }
  return pick(d.sprints, name, (s) => s.name, 'sprint', `in ${d.team.name}`)
}

/**
 * Jira owns most of what a mirrored issue has: the next pull overwrites it, so
 * a change made here would last fifteen minutes and then quietly vanish.
 */
function guardJira(t: Task, what: string) {
  if (t.jira) {
    throw new ToolError(`${t.key} comes from Jira, which owns its ${what}: the next pull would undo a change made in `
      + 'Scrumly. Suggest the change for Jira instead. Reviewer, tester and blockers are Scrumly\'s and can be changed.')
  }
}

const taskTitle = (t: Task) => `${t.key} · ${t.title}`

async function stillThere(id: ID): Promise<Task> {
  const t = await taskRepo.get(id)
  if (!t) throw new Error('That task has been deleted since')
  return t
}

// ---------- the tools ----------

type Run = (a: Args, w: World) => Promise<ToolOutcome>
interface ToolSpec { def: Anthropic.Beta.BetaTool; run: Run }

const str = (description: string) => ({ type: 'string', description })
const TEAM = str('Team name. Leave out for the team open in Scrumly.')
const KEY = str('Task key, for example PAY-12.')
const PERSON = 'A person\'s name as Scrumly has it; a first name is enough when it is unique.'
const SPRINT = str('"running", "next", "last" (most recently closed), "none", or a sprint\'s name.')
const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high', 'urgent']
const NOTE_KINDS: readonly NoteType[] = ['retro', 'meeting', 'idea', 'improvement', 'oneToOne']
const WAIT_KINDS: readonly Blocker['waitingOnType'][] = ['person', 'team', 'external', 'task']

function tool(name: string, description: string, properties: Record<string, unknown>, req: string[], run: Run): ToolSpec {
  return {
    def: {
      name,
      description,
      input_schema: { type: 'object', properties, required: req },
      // Streams the input as it is written. The server then no longer checks
      // it against the schema, which is why every tool reads its input itself.
      eager_input_streaming: true,
    },
    run,
  }
}

const read = (text: string, note: string): ToolOutcome => ({ kind: 'result', text, note })
const propose = (proposal: Proposal): ToolOutcome => ({ kind: 'proposal', proposal })

const SPECS: ToolSpec[] = [
  tool('read_team',
    'A fresh snapshot of one team as it is right now: columns, people, sprints with burndown and velocity, all open work, '
    + 'blockers, the user\'s follow-ups and the last stand-up. Use it after changes were applied, when the user may have '
    + 'changed things themselves, or to look at a team other than the open one.',
    { team: TEAM }, [],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      return read(await teamReport(team, w.sight), `Read the ${team.name} board`)
    }),

  tool('read_task',
    'Everything about one task: its description, people, dates, blocker and chase log, dependencies, links, '
    + 'and every move it has made between columns and sprints.',
    { key: KEY }, ['key'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const team = w.sight.teams.find((x) => x.id === t.teamId)!
      const d = await loadTeam(team, w.sight)
      const now = Date.now()
      const status = d.ix.byStatus.get(t.statusId)
      const out = [`${t.key} — ${t.title}${t.jira ? ' [from Jira]' : ''}`, `Team: ${team.name}`, TASK_HEADER, taskLine(t, d, now)]
      if (t.project) out.push(`Project: ${t.project}`)
      if (t.tags.length) out.push(`Tags: ${t.tags.join(', ')}`)
      out.push(`Created ${todayISO(new Date(t.createdAt))}, last changed ${todayISO(new Date(t.updatedAt))}.`)
      out.push('', 'Description:', t.description.trim() ? t.description.trim().slice(0, 6000) : '(none)')

      const blocker = await blockerRepo.openForTask(t.id)
      if (blocker) {
        const waitTask = blocker.waitingOnTaskId ? await db.tasks.get(blocker.waitingOnTaskId) : null
        out.push('', `Blocked ${blockedDays(blocker)} days: "${cell(blocker.reason)}", waiting on `
          + `${describeWaitingOn(blocker, blocker.waitingOnPersonId ? personName(d, blocker.waitingOnPersonId) : null, waitTask?.key ?? null)}.`)
        for (const c of await blockerRepo.chasesFor(blocker.id)) {
          out.push(`  chased ${todayISO(new Date(c.at))}${c.note ? `: ${cell(c.note)}` : ''}`)
        }
      }

      const [waitsOn, holdsUp] = await Promise.all([
        db.taskLinks.where('toTaskId').equals(t.id).toArray(),
        db.taskLinks.where('fromTaskId').equals(t.id).toArray(),
      ])
      const describe = async (id: ID) => {
        const other = w.sight.sees('tasks', id) ? await db.tasks.get(id) : null
        if (!other) return 'a task you cannot see'
        return `${other.key} "${cell(other.title)}" (${d.ix.byStatus.get(other.statusId)?.name ?? '?'})`
      }
      if (waitsOn.length) out.push('', `Waits on: ${(await Promise.all(waitsOn.map((l) => describe(l.fromTaskId)))).join('; ')}`)
      if (holdsUp.length) out.push(`Holds up: ${(await Promise.all(holdsUp.map((l) => describe(l.toTaskId)))).join('; ')}`)

      const links = await db.externalLinks.where('taskId').equals(t.id).toArray()
      if (links.length) out.push('', 'Links:', ...links.map((l) => `  ${cell(l.label)} — ${l.url}`))

      out.push('', 'History:')
      for (const e of d.statusEvents.filter((x) => x.taskId === t.id).sort((x, y) => x.at - y.at)) {
        const to = d.ix.byStatus.get(e.toStatusId)?.name ?? '?'
        out.push(`  ${todayISO(new Date(e.at))} ${e.fromStatusId ? `${d.ix.byStatus.get(e.fromStatusId)?.name ?? '?'} → ${to}` : `created in ${to}`}`)
      }
      for (const e of d.sprintEvents.filter((x) => x.taskId === t.id).sort((x, y) => x.at - y.at)) {
        out.push(`  ${todayISO(new Date(e.at))} sprint ${sprintName(d, e.fromSprintId)} → ${sprintName(d, e.toSprintId)}`)
      }
      if (status?.isDone && t.closedAt) out.push(`Finished ${todayISO(new Date(t.closedAt))}.`)
      return read(out.join('\n'), `Read ${t.key}`)
    }),

  tool('find_tasks',
    'Search one team\'s tasks, the backlog and (if asked) finished work included. Every filter is optional and they combine.',
    {
      text: str('Words to look for in the key, title, description or tags.'),
      person: str(`Assignee, reviewer or tester. ${PERSON}`),
      column: str('A column\'s name.'),
      sprint: SPRINT,
      flag: { type: 'string', enum: ['blocked', 'stuck', 'overdue', 'unassigned'], description: 'Only tasks with this problem.' },
      include_done: { type: 'boolean', description: 'Include finished tasks. Off unless asked.' },
      limit: { type: 'integer', description: 'At most this many, newest change first. Default 50, at most 200.' },
      team: TEAM,
    }, [],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const now = Date.now()
      let list = d.tasks
      if (!bool(a, 'include_done')) list = list.filter((t) => !d.ix.doneIds.has(t.statusId))
      const words = text(a, 'text')
      if (words) {
        const n = words.toLowerCase()
        list = list.filter((t) => [t.key, t.title, t.description, t.tags.join(' ')].join(' ').toLowerCase().includes(n))
      }
      const who = text(a, 'person')
      if (who) {
        const p = personFor(d, who)
        list = list.filter((t) => t.assigneeId === p.id || t.reviewerId === p.id || t.testerId === p.id)
      }
      const col = text(a, 'column')
      if (col) { const s = columnFor(d, col); list = list.filter((t) => t.statusId === s.id) }
      const spr = text(a, 'sprint')
      if (spr) { const s = sprintFor(d, spr); list = list.filter((t) => t.sprintId === (s?.id ?? null)) }
      const flag = oneOf(a, 'flag', ['blocked', 'stuck', 'overdue', 'unassigned'] as const)
      if (flag === 'blocked') list = list.filter((t) => d.ix.blockerByTask.has(t.id))
      if (flag === 'stuck') list = list.filter((t) => isStuckTask(t, d.ix, now))
      if (flag === 'overdue') list = list.filter((t) => isOverdue(t, d.ix))
      if (flag === 'unassigned') list = list.filter((t) => isUnowned(t, d.ix))
      const limit = num(a, 'limit', { min: 1, max: 200 }) ?? 50
      const sorted = [...list].sort((x, y) => y.updatedAt - x.updatedAt)
      const out = [`${list.length} task${list.length === 1 ? '' : 's'} in ${team.name} match.`]
      if (list.length) out.push(TASK_HEADER, ...sorted.slice(0, limit).map((t) => taskLine(t, d, now)))
      if (list.length > limit) out.push(`…${list.length - limit} more not shown.`)
      return read(out.join('\n'), `Searched the ${team.name} tasks`)
    }),

  tool('read_sprint',
    'One sprint in detail: dates, goal, scope (there at the start, added, taken out), points, the burndown, every task in it, '
    + 'and each move in or out with its date. Defaults to the running sprint.',
    { sprint: SPRINT, team: TEAM }, [],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const s = sprintFor(d, text(a, 'sprint') || 'running')
      if (!s) throw new ToolError('Name a sprint')
      const now = Date.now()
      const out = sprintSummary(s, d, now, true)
      const inIt = d.tasks.filter((t) => t.sprintId === s.id)
      out.push('', `Tasks in it now (${inIt.length}):`, TASK_HEADER, ...inIt.map((t) => taskLine(t, d, now)))
      const byPerson = new Map<string, { points: number; done: number }>()
      for (const t of inIt) {
        const who = personName(d, t.assigneeId)
        const cur = byPerson.get(who) ?? { points: 0, done: 0 }
        cur.points += t.size ?? 0
        if (d.ix.doneIds.has(t.statusId)) cur.done += t.size ?? 0
        byPerson.set(who, cur)
      }
      if (byPerson.size) {
        out.push('', 'Points by assignee (done / total): '
          + [...byPerson].map(([who, p]) => `${who === '–' ? 'nobody' : who} ${p.done}/${p.points}`).join(', '))
      }
      const moves = d.sprintEvents
        .filter((e) => (e.toSprintId === s.id || e.fromSprintId === s.id) && e.fromSprintId !== e.toSprintId)
        .sort((x, y) => x.at - y.at)
      if (moves.length) {
        out.push('', 'Moves in and out:')
        for (const e of moves) {
          const t = d.tasks.find((x) => x.id === e.taskId)
          out.push(`  ${todayISO(new Date(e.at))} ${t?.key ?? '?'} ${e.toSprintId === s.id ? `joined (from ${sprintName(d, e.fromSprintId)})` : `left (to ${sprintName(d, e.toSprintId)})`}`)
        }
      }
      return read(out.join('\n'), `Read ${s.name}`)
    }),

  tool('read_standups',
    'What each person said at recent stand-ups, in their own words, oldest first.',
    {
      person: str(`Only this person. ${PERSON}`),
      days: { type: 'integer', description: 'How far back, in calendar days. Default 10, at most 60.' },
      team: TEAM,
    }, [],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const days = num(a, 'days', { min: 1, max: 60 }) ?? 10
      const who = text(a, 'person')
      const person = who ? personFor(d, who) : null
      const since = Date.now() - days * 86_400_000
      const said = (await db.standupNotes.where('teamId').equals(team.id).toArray())
        .filter((n) => n.at >= since && w.sight.sees('standupNotes', n.id) && d.people.has(n.personId))
        .filter((n) => !person || n.personId === person.id)
        .sort((x, y) => x.at - y.at)
      const out = said.length
        ? said.map((n) => `${n.date} ${personName(d, n.personId)}: "${cell(n.text)}"`)
        : [`Nothing written down at ${team.name}'s stand-ups in the last ${days} days${person ? ` for ${person.name}` : ''}.`]
      return read(out.join('\n'), `Read the ${team.name} stand-up notes`)
    }),

  tool('read_notes',
    'The user\'s notes — retros, meetings, ideas, improvements, one-to-ones not marked private — newest first. '
    + 'A retro comes with what each of its actions turned into and whether that is done. Private notes are never shown.',
    {
      type: { type: 'string', enum: NOTE_KINDS, description: 'Only notes of this kind.' },
      text: str('Words to look for in the title or body.'),
      limit: { type: 'integer', description: 'Default 5, at most 15.' },
      team: TEAM,
    }, [],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const kind = oneOf(a, 'type', NOTE_KINDS)
      const words = text(a, 'text')?.toLowerCase()
      const limit = num(a, 'limit', { min: 1, max: 15 }) ?? 5
      const list = (await noteRepo.list())
        .filter((n) => readableNote(n) && w.sight.sees('notes', n.id))
        // A note with no team is everyone's, as on the Notes screen.
        .filter((n) => n.teamId === null || n.teamId === team.id)
        .filter((n) => !kind || n.type === kind)
        .filter((n) => !words || `${n.title}\n${n.body}`.toLowerCase().includes(words))
        .slice(0, limit)
      if (!list.length) return read(`No ${kind ?? ''} notes${words ? ` mentioning "${words}"` : ''} for ${team.name}.`, 'Looked through notes')
      const statuses = await db.statuses.toArray()
      const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))
      const out: string[] = []
      for (const n of list) {
        out.push(`### ${n.title} (${n.type}, ${todayISO(new Date(n.createdAt))})`, n.body.trim().slice(0, 4000) || '(empty)')
        const conv = await noteRepo.conversionsFor(n.id)
        if (conv.length) {
          const made = await db.tasks.where('id').anyOf(conv.map((c) => c.createdId)).toArray()
          const fus = await db.followUps.where('id').anyOf(conv.map((c) => c.createdId)).toArray()
          out.push('Actions taken from it:')
          for (const o of actionOutcomes(conv, made, fus, doneIds)) {
            out.push(`  - ${cell(o.title)} (${o.kind === 'task' ? 'task' : 'follow-up'}): ${o.done ? 'done' : o.gone ? 'deleted' : 'still open'}`)
          }
        }
        out.push('')
      }
      return read(out.join('\n'), 'Read notes')
    }),

  tool('read_blocker_history',
    'Every blocker on a team\'s tasks over a period, open and resolved, with the days lost grouped by what the work was '
    + 'waiting on. For retros, and for escalating something that keeps costing days.',
    { days: { type: 'integer', description: 'Blockers opened in the last this-many days. Default 90.' }, team: TEAM }, [],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const days = num(a, 'days', { min: 1, max: 730 }) ?? 90
      const since = Date.now() - days * 86_400_000
      const onTeam = new Set(d.tasks.map((t) => t.id))
      const rows = (await db.blockers.toArray()).filter((b) => onTeam.has(b.taskId) && b.openedAt >= since)
      if (!rows.length) return read(`No blockers on ${team.name}'s tasks in the last ${days} days.`, 'Read blocker history')
      const keyOf = (id: ID | null) => (id ? d.tasks.find((t) => t.id === id)?.key ?? null : null)
      const label = (b: Blocker) => describeWaitingOn(b, b.waitingOnPersonId ? personName(d, b.waitingOnPersonId) : null, keyOf(b.waitingOnTaskId))
      const out = ['Days lost, by what the work waited on:']
      for (const g of groupWaitingOn(rows, label)) {
        out.push(`  ${g.label}: ${g.days} days over ${g.count} blocker${g.count === 1 ? '' : 's'}${g.stillOpen ? `, ${g.stillOpen} still open` : ''}`)
      }
      out.push('', 'Each blocker:')
      for (const b of rows.sort((x, y) => x.openedAt - y.openedAt)) {
        out.push(`  ${keyOf(b.taskId)} opened ${todayISO(new Date(b.openedAt))}, ${blockedDays(b)} days, "${cell(b.reason)}", waiting on ${label(b)}`
          + (b.resolvedAt ? `, resolved ${todayISO(new Date(b.resolvedAt))}${b.resolutionNote ? ` ("${cell(b.resolutionNote)}")` : ''}` : ', still open'))
      }
      return read(out.join('\n'), 'Read blocker history')
    }),

  // ----- proposals -----

  tool('create_task',
    'Propose a new task. The user sees it and decides; nothing is created until they apply it.',
    {
      title: str('What needs doing, as a short task title.'),
      description: str('Anything the person picking it up would ask.'),
      column: str('Which column it starts in. Default: the first column (the backlog).'),
      assignee: str(PERSON), reviewer: str(PERSON), tester: str(PERSON),
      priority: { type: 'string', enum: PRIORITIES },
      size: { type: 'number', description: 'Points.' },
      due_date: str('YYYY-MM-DD.'),
      sprint: SPRINT,
      tags: { type: 'array', items: { type: 'string' } },
      team: TEAM,
    }, ['title'],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const title = required(a, 'title')
      const description = text(a, 'description') ?? ''
      const colName = text(a, 'column')
      const status = colName ? columnFor(d, colName) : d.statuses[0]
      if (!status) throw new ToolError('The board has no columns yet')
      const assigneeId = personOrNobody(d, a, 'assignee') ?? null
      const reviewerId = personOrNobody(d, a, 'reviewer') ?? null
      const testerId = personOrNobody(d, a, 'tester') ?? null
      const priority = oneOf(a, 'priority', PRIORITIES) ?? 'normal'
      const size = num(a, 'size', { min: 0 }) ?? null
      const due = nullable(a, 'due_date')
      const dueDate = due ? isoDate(due, 'due_date') : null
      const sprintText = text(a, 'sprint')
      const sprint = sprintText ? sprintFor(d, sprintText) : null
      const tags = tagsOf(a, 'tags') ?? []

      const lines = [`"${title}"`, `Column: ${status.name}`]
      if (assigneeId) lines.push(`Assignee: ${personName(d, assigneeId)}`)
      if (reviewerId) lines.push(`Reviewer: ${personName(d, reviewerId)}`)
      if (testerId) lines.push(`Tester: ${personName(d, testerId)}`)
      if (priority !== 'normal') lines.push(`Priority: ${priority}`)
      if (size != null) lines.push(`Size: ${size} points`)
      if (dueDate) lines.push(`Due: ${formatDate(dueDate)}`)
      if (sprint) lines.push(`Sprint: ${sprint.name}`)
      if (tags.length) lines.push(`Tags: ${tags.join(', ')}`)
      return propose({
        title: `Create a task in ${team.name}`,
        lines,
        body: description || undefined,
        async apply() {
          const t = await taskRepo.create({
            teamId: team.id, statusId: status.id, title, description, assigneeId, reviewerId, testerId, priority, size, dueDate, tags,
          })
          // Through setSprint rather than create, so the join is logged like any other.
          if (sprint) await taskRepo.setSprint(t.id, sprint.id)
          return `Applied: created ${t.key} in ${status.name}${sprint ? `, in ${sprint.name}` : ''}.`
        },
      })
    }),

  tool('update_task',
    'Propose changing a task\'s fields. Only the fields given change; "none" clears a person, the size or the due date. '
    + 'Use move_task for the column and set_task_sprint for the sprint.',
    {
      key: KEY,
      title: str('A new title.'),
      description: str('A new description, replacing the old one entirely.'),
      assignee: str(PERSON), reviewer: str(PERSON), tester: str(PERSON),
      priority: { type: 'string', enum: PRIORITIES },
      size: { type: ['number', 'string'], description: 'Points, or "none".' },
      due_date: str('YYYY-MM-DD, or "none".'),
      tags: { type: 'array', items: { type: 'string' }, description: 'The full new list of tags.' },
    }, ['key'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const team = w.sight.teams.find((x) => x.id === t.teamId)!
      const d = await loadTeam(team, w.sight)
      const patch: Partial<Task> = {}
      const lines: string[] = []
      const jiraFields: string[] = []
      const change = <K extends keyof Task>(field: K, next: Task[K], label: string, show: (v: Task[K]) => string, jira: boolean) => {
        if (JSON.stringify(t[field]) === JSON.stringify(next)) return
        if (jira) jiraFields.push(label.toLowerCase())
        patch[field] = next
        lines.push(`${label}: ${show(t[field])} → ${show(next)}`)
      }
      const show = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : Array.isArray(v) ? v.join(', ') || 'none' : String(v))
      const who = (id: unknown) => personName(d, (id as ID | null) ?? null).replace(/^–$/, 'nobody')

      const title = text(a, 'title')
      if (title) change('title', title, 'Title', show, true)
      const desc = text(a, 'description')
      if (desc !== undefined) change('description', desc, 'Description', () => '', true)
      for (const [field, label, jira] of [['assigneeId', 'Assignee', true], ['reviewerId', 'Reviewer', false], ['testerId', 'Tester', false]] as const) {
        const id = personOrNobody(d, a, label.toLowerCase())
        if (id !== undefined) change(field, id, label, who, jira)
      }
      const priority = oneOf(a, 'priority', PRIORITIES)
      if (priority) change('priority', priority, 'Priority', show, true)
      if (a.size !== undefined) {
        const raw = a.size
        const n = raw === null || (typeof raw === 'string' && CLEARS.has(raw.trim().toLowerCase())) ? null : Number(raw)
        if (n !== null && (!Number.isFinite(n) || n < 0)) throw new ToolError('size must be a number of points, or "none"')
        change('size', n, 'Size', show, true)
      }
      const due = nullable(a, 'due_date')
      if (due !== undefined) change('dueDate', due === null ? null : isoDate(due, 'due_date'), 'Due', (v) => formatDate(v, 'none'), true)
      const tags = tagsOf(a, 'tags')
      if (tags) change('tags', tags, 'Tags', show, true)

      if (jiraFields.length) guardJira(t, jiraFields.join(', '))
      if (!lines.length) throw new ToolError(`Nothing about ${t.key} would change`)
      return propose({
        title: `Update ${taskTitle(t)}`,
        lines: lines.filter((l) => !l.startsWith('Description')),
        body: 'description' in patch ? `New description:\n${patch.description || '(empty)'}` : undefined,
        async apply() {
          await stillThere(t.id)
          await taskRepo.update(t.id, patch)
          return `Applied: ${t.key} updated (${lines.map((l) => l.split(':')[0].toLowerCase()).join(', ')}).`
        },
      })
    }),

  tool('move_task',
    'Propose moving a task to another column.',
    { key: KEY, column: str('The column\'s name.') }, ['key', 'column'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const d = await loadTeam(w.sight.teams.find((x) => x.id === t.teamId)!, w.sight)
      const to = columnFor(d, required(a, 'column'))
      const from = d.ix.byStatus.get(t.statusId)
      if (to.id === t.statusId) throw new ToolError(`${t.key} is already in ${to.name}`)
      guardJira(t, 'column')
      return propose({
        title: `Move ${taskTitle(t)}`,
        lines: [`${from?.name ?? '?'} → ${to.name}`],
        async apply() {
          await stillThere(t.id)
          await taskRepo.move(t.id, to.id, null)
          return `Applied: ${t.key} is now in ${to.name}.`
        },
      })
    }),

  tool('set_task_sprint',
    'Propose putting a task into a sprint, or taking it out of one.',
    { key: KEY, sprint: SPRINT }, ['key', 'sprint'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const d = await loadTeam(w.sight.teams.find((x) => x.id === t.teamId)!, w.sight)
      const s = sprintFor(d, required(a, 'sprint'))
      if ((s?.id ?? null) === t.sprintId) throw new ToolError(`${t.key} is already ${s ? `in ${s.name}` : 'in no sprint'}`)
      if (s?.state === 'closed') throw new ToolError(`${s.name} is closed`)
      guardJira(t, 'sprint')
      return propose({
        title: s ? `Put ${taskTitle(t)} in ${s.name}` : `Take ${taskTitle(t)} out of its sprint`,
        lines: [`Sprint: ${sprintName(d, t.sprintId)} → ${s ? sprintName(d, s.id) : 'none'}`],
        async apply() {
          await stillThere(t.id)
          await taskRepo.setSprint(t.id, s?.id ?? null)
          return `Applied: ${t.key} is ${s ? `in ${s.name}` : 'in no sprint'}.`
        },
      })
    }),

  tool('flag_blocked',
    'Propose flagging a task as blocked, or rewording the blocker on one that already is. The task stays in its column.',
    {
      key: KEY,
      reason: str('What is stopping the work.'),
      waiting_on_type: { type: 'string', enum: WAIT_KINDS, description: 'Who or what it waits on.' },
      waiting_on: str('For a person: their name. For a task: its key. Otherwise the team or outside party, in words.'),
    }, ['key', 'reason', 'waiting_on_type', 'waiting_on'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const d = await loadTeam(w.sight.teams.find((x) => x.id === t.teamId)!, w.sight)
      const reason = required(a, 'reason')
      const kind = oneOf(a, 'waiting_on_type', WAIT_KINDS) ?? 'external'
      const on = required(a, 'waiting_on')
      const input = { reason, waitingOnType: kind, waitingOnPersonId: null as ID | null, waitingOnTaskId: null as ID | null, waitingOnText: null as string | null }
      let onLabel = on
      if (kind === 'person') { const p = personFor(d, on); input.waitingOnPersonId = p.id; onLabel = p.name }
      else if (kind === 'task') {
        const other = await taskFor(w, on)
        if (other.id === t.id) throw new ToolError('A task cannot wait on itself')
        input.waitingOnTaskId = other.id
        onLabel = other.key
      } else input.waitingOnText = on
      const existing = await blockerRepo.openForTask(t.id)
      return propose({
        title: existing ? `Change the blocker on ${taskTitle(t)}` : `Flag ${taskTitle(t)} as blocked`,
        lines: [`Reason: ${reason}`, `Waiting on: ${onLabel} (${kind})`],
        async apply() {
          await stillThere(t.id)
          await blockerRepo.open(t.id, input)
          return `Applied: ${t.key} is ${existing ? 'still' : 'now'} blocked, waiting on ${onLabel}.`
        },
      })
    }),

  tool('log_chase',
    'Propose logging that a blocker was chased. "Four days, chased twice" is what gets escalated.',
    { key: KEY, note: str('Who was chased and how, for example "Emailed the vendor again".') }, ['key'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const b = await blockerRepo.openForTask(t.id)
      if (!b) throw new ToolError(`${t.key} is not blocked`)
      const note = text(a, 'note') ?? ''
      return propose({
        title: `Log a chase on ${taskTitle(t)}`,
        lines: [note ? `Note: ${note}` : 'No note'],
        async apply() {
          await blockerRepo.chase(b.id, note)
          return `Applied: chase logged on ${t.key}.`
        },
      })
    }),

  tool('resolve_blocker',
    'Propose marking a task\'s blocker resolved. Resolved blockers are kept, so the days lost still count.',
    { key: KEY, note: str('How it was resolved.') }, ['key'],
    async (a, w) => {
      const t = await taskFor(w, required(a, 'key'))
      const b = await blockerRepo.openForTask(t.id)
      if (!b) throw new ToolError(`${t.key} is not blocked`)
      const note = text(a, 'note') ?? ''
      return propose({
        title: `Resolve the blocker on ${taskTitle(t)}`,
        lines: [`Blocked ${blockedDays(b)} days: ${b.reason}`, ...(note ? [`Resolution: ${note}`] : [])],
        async apply() {
          await blockerRepo.resolve(b.id, note)
          return `Applied: ${t.key}'s blocker is resolved after ${blockedDays(b)} days.`
        },
      })
    }),

  tool('add_follow_up',
    'Propose a follow-up: one of the user\'s own to-dos — talk to someone, check on something — not work for the team.',
    { title: str('What to do.'), due_date: str('YYYY-MM-DD.'), person: str(`Who it is about. ${PERSON}`), team: TEAM }, ['title'],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const title = required(a, 'title')
      const due = nullable(a, 'due_date')
      const dueDate = due ? isoDate(due, 'due_date') : null
      const personId = personOrNobody(d, a, 'person') ?? null
      return propose({
        title: 'Add a follow-up for you',
        lines: [`"${title}"`, ...(dueDate ? [`Due: ${formatDate(dueDate)}`] : []), ...(personId ? [`About: ${personName(d, personId)}`] : [])],
        async apply() {
          await followUpRepo.create({ title, dueDate, personId })
          return 'Applied: follow-up added.'
        },
      })
    }),

  tool('complete_follow_up',
    'Propose ticking off one of the user\'s open follow-ups.',
    { follow_up: str('Its title, or enough of it to be unique.') }, ['follow_up'],
    async (a, w) => {
      const open = (await followUpRepo.listOpen()).filter((f) => w.sight.sees('followUps', f.id))
      const f = pick(open, required(a, 'follow_up'), (x) => x.title, 'open follow-up', 'among the open ones')
      return propose({
        title: 'Mark a follow-up done',
        lines: [`"${f.title}"`],
        async apply() {
          await followUpRepo.complete(f.id)
          return 'Applied: follow-up done.'
        },
      })
    }),

  tool('write_note',
    'Propose saving a note on the Notes screen — when the user wants a draft kept: retro talking points, a sprint review '
    + 'summary, meeting notes. One-to-one notes are saved as private.',
    {
      type: { type: 'string', enum: NOTE_KINDS },
      title: str('The note\'s title.'),
      body: str('The note itself. Plain text; "- " starts a list item.'),
      person: str(`Who a one-to-one is with. ${PERSON}`),
      sprint: SPRINT,
      team: TEAM,
    }, ['type', 'title', 'body'],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const type = oneOf(a, 'type', NOTE_KINDS) ?? 'meeting'
      const title = required(a, 'title')
      const body = required(a, 'body')
      const personId = personOrNobody(d, a, 'person') ?? null
      const sprintText = text(a, 'sprint')
      const sprint = sprintText ? sprintFor(d, sprintText) : null
      return propose({
        title: `Save a ${type === 'oneToOne' ? 'one-to-one' : type} note`,
        lines: [`"${title}" in ${team.name}`, ...(personId ? [`With: ${personName(d, personId)}`] : []), ...(sprint ? [`Sprint: ${sprint.name}`] : [])],
        body,
        async apply() {
          const note = await noteRepo.create({ type, title, teamId: team.id, personId, sprintId: sprint?.id ?? null })
          await noteRepo.update(note.id, { body })
          return `Applied: note "${title}" saved${note.isPrivate ? ' as private' : ''}.`
        },
      })
    }),

  tool('set_sprint_goal',
    'Propose setting a sprint\'s goal. Defaults to the running sprint, or the next one if none is running.',
    { goal: str('The goal, in a sentence.'), sprint: SPRINT, team: TEAM }, ['goal'],
    async (a, w) => {
      const team = teamFor(w, text(a, 'team'))
      const d = await loadTeam(team, w.sight)
      const named = text(a, 'sprint')
      const s = named ? sprintFor(d, named)
        : d.sprints.find((x) => x.state === 'active') ?? d.sprints.find((x) => x.state === 'planned') ?? null
      if (!s) throw new ToolError(`${team.name} has no running or planned sprint`)
      if (s.jira) throw new ToolError(`${s.name} comes from Jira, which owns it — set the goal there`)
      const goal = required(a, 'goal')
      return propose({
        title: `Set ${s.name}'s goal`,
        lines: [`${s.goal ? `"${s.goal}"` : 'none'} → "${goal}"`],
        async apply() {
          const r = await sprintRepo.update(s.id, { goal })
          if (!r.ok) throw new Error(r.reason ?? 'The sprint could not be changed')
          return `Applied: ${s.name}'s goal is set.`
        },
      })
    }),
]

const BY_NAME = new Map(SPECS.map((s) => [s.def.name, s]))

/** What Claude is told it can call. Stable, in a fixed order, so the prompt cache holds across turns. */
export const TOOLS: Anthropic.Beta.BetaToolUnion[] = SPECS.map((s) => s.def)

/**
 * Runs one tool call. Never throws: a mistake goes back to Claude as an error
 * result it can correct, and anything unexpected says so plainly.
 */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const spec = BY_NAME.get(name)
  if (!spec) return { kind: 'result', text: `There is no tool called ${name}`, error: true }
  try {
    return await spec.run(argsOf(input), { sight: await sight(), activeTeamId: ctx.activeTeamId })
  } catch (err) {
    if (err instanceof ToolError) return { kind: 'result', text: err.message, error: true }
    return { kind: 'result', text: `That failed: ${err instanceof Error ? err.message : String(err)}`, error: true }
  }
}
