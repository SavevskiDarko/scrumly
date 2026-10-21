import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from './Avatar'
import { Burndown } from './Burndown'
import { useToast } from './Toast'
import { db } from '../db/schema'
import type { ID, Person, Sprint, SprintEvent, Status, StatusEvent, Task } from '../db/types'
import { go, setParam } from '../hooks/useRoute'
import { formatDate } from '../lib/dates'
import { endOfDay, eventsByTask, finishedIn, pointsOf, sprintStats, todayISO, type SprintStats } from '../repo'

/** Sizes can be halves, and a sum of them should not print as 2.9999999999999996. */
const num = (n: number) => String(Math.round(n * 10) / 10)
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`
const pointsIn = (list: Task[]) => list.reduce((sum, t) => sum + pointsOf(t), 0)

/** A task the sprint held at the end without finishing, and where it went. */
export interface Leftover {
  task: Task
  /** Its column when the sprint closed, or now while it runs. */
  statusId: ID
  /**
   * Where it went when the sprint closed: another sprint, or null for the
   * backlog. Undefined while the sprint runs, and for anything a close left
   * where it was.
   */
  movedTo?: ID | null
}

export interface SprintReportData {
  /** The burndown, day count and unit: sprintStats, over what the sprint held at the end. */
  stats: SprintStats
  /** When it closed. Null while it runs. */
  endedAt: number | null
  /** What it held at the end: when it closed, or now while it runs. */
  held: Task[]
  /** Of those, the ones in it by the end of its first day. */
  committed: Task[]
  /** And the ones that arrived after that. */
  added: Task[]
  /** Finished while they belonged to it, in the order they were finished. */
  delivered: Task[]
  /** Held at the end and not finished, furthest along first. */
  leftover: Leftover[]
  /** Taken out while it ran and not put back, with when. */
  removed: { task: Task; at: number }[]
  /** Held at the end and done, but finished before they joined: delivered by another sprint, or by none. */
  arrivedDone: Task[]
  /** Delivered of committed, in points, or in tasks when nothing committed was sized. Null with no commitment. */
  sayDo: { unit: 'points' | 'tasks'; committed: number; delivered: number } | null
}

/** Every move a task has made between sprints, oldest first. */
function movesByTask(sprintEvents: SprintEvent[]): Map<ID, SprintEvent[]> {
  const byTask = new Map<ID, SprintEvent[]>()
  for (const e of sprintEvents) {
    const list = byTask.get(e.taskId) ?? []
    list.push(e)
    byTask.set(e.taskId, list)
  }
  for (const list of byTask.values()) list.sort((a, b) => a.at - b.at)
  return byTask
}

/**
 * The sprint a task was in just before a moment. Before its first logged move
 * it was wherever that move took it from; a task that never moved is where it
 * is now, which covers work created straight into a sprint and anything from
 * before the log existed.
 */
function sprintAt(task: Task, moves: SprintEvent[], at: number): ID | null {
  if (task.createdAt > at) return null
  let last: SprintEvent | null = null
  for (const e of moves) { if (e.at < at) last = e; else break }
  if (last) return last.toSprintId
  return moves.length ? moves[0].fromSprintId : task.sprintId
}

/**
 * A sprint as its review would tell it: what it held at the end, how much of
 * that was there from day one, what it delivered and where the rest went.
 *
 * sprintStats reads membership off task.sprintId, which is right while a
 * sprint runs and wrong once it has closed: closing carries the unfinished work
 * out, so a closed sprint would chart as though it had finished everything it
 * held. Here a closed sprint is replayed from sprintEvents as it stood the
 * moment it closed, and sprintStats is handed that instead. Nothing is stored;
 * every number still comes from the two logs.
 */
export function sprintReport(
  sprint: Sprint,
  tasks: Task[],
  statusEvents: StatusEvent[],
  sprintEvents: SprintEvent[],
  statuses: Status[],
  opts: { now?: number; holidays?: readonly string[] } = {},
): SprintReportData {
  const now = opts.now ?? Date.now()
  const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))
  const history = eventsByTask(statusEvents)
  const moves = movesByTask(sprintEvents)
  const endedAt = sprint.state === 'closed' ? sprint.closedAt ?? endOfDay(sprint.endDate) : null
  const until = endedAt ?? now

  // Strictly before the close: close() stamps closedAt and only then carries
  // the leftovers out, so a move in the same millisecond is the carry.
  const held = endedAt === null
    ? tasks.filter((t) => t.sprintId === sprint.id)
    : tasks.filter((t) => sprintAt(t, moves.get(t.id) ?? [], endedAt) === sprint.id)
  const heldIds = new Set(held.map((t) => t.id))
  const asHeld = endedAt === null ? tasks : tasks.map((t) => (
    heldIds.has(t.id) === (t.sprintId === sprint.id) ? t : { ...t, sprintId: heldIds.has(t.id) ? sprint.id : null }
  ))
  const stats = sprintStats(sprint, asHeld, statusEvents, sprintEvents, statuses, { now: until, holidays: opts.holidays })

  // The line sprintStats draws: in by the end of the first day is committed.
  const startTs = endOfDay(sprint.startDate)
  const arrived = new Map<ID, number>()
  for (const e of sprintEvents) {
    if (e.toSprintId !== sprint.id) continue
    const seen = arrived.get(e.taskId)
    if (seen === undefined || e.at < seen) arrived.set(e.taskId, e.at)
  }
  const isCommitted = (t: Task) => (arrived.get(t.id) ?? t.createdAt) <= startTs
  const committed = held.filter(isCommitted)
  const added = held.filter((t) => !isCommitted(t))

  // A running sprint has not closed, so finishedIn reads it as though it
  // closed now: what it has delivered so far.
  const delivered = finishedIn(endedAt === null ? { ...sprint, closedAt: now } : sprint, tasks, history, doneIds)
  const deliveredIds = new Set(delivered.map((t) => t.id))

  /** The column a task sat in at the end, and since when. */
  const standing = (t: Task) => {
    let last: StatusEvent | null = null
    for (const e of history.get(t.id) ?? []) { if (e.at <= until) last = e; else break }
    return last ? { statusId: last.toStatusId, since: last.at } : { statusId: t.statusId, since: t.statusChangedAt }
  }
  delivered.sort((a, b) => standing(a).since - standing(b).since)

  const order = new Map(statuses.map((s) => [s.id, s.order]))
  const leftover: Leftover[] = []
  const arrivedDone: Task[] = []
  for (const t of held) {
    if (deliveredIds.has(t.id)) continue
    const { statusId } = standing(t)
    if (doneIds.has(statusId)) { arrivedDone.push(t); continue }
    const out = endedAt === null
      ? undefined
      : moves.get(t.id)?.find((e) => e.fromSprintId === sprint.id && e.at >= endedAt)
    leftover.push({ task: t, statusId, movedTo: out ? out.toSprintId : undefined })
  }
  // Furthest along first: the nearly-done ones are the ones worth talking about.
  leftover.sort((a, b) => (order.get(b.statusId) ?? 0) - (order.get(a.statusId) ?? 0))

  /*
   * Taken out while it ran: a move out after the first day and before the end,
   * not undone by the end. sprintStats.removed also counts moves made while it
   * was still being planned, and counts a task twice for leaving twice; a
   * report read by people outside the team would show that as scope cut.
   */
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const removed: { task: Task; at: number }[] = []
  for (const [taskId, list] of moves) {
    const task = byId.get(taskId)
    if (!task || heldIds.has(taskId)) continue
    const out = list.filter((e) => e.fromSprintId === sprint.id && e.at > startTs && e.at < until).pop()
    if (out) removed.push({ task, at: out.at })
  }
  removed.sort((a, b) => a.at - b.at)

  const byPoints = committed.some((t) => pointsOf(t) > 0)
  const weigh = (list: Task[]) => (byPoints ? pointsIn(list) : list.length)
  const sayDo = committed.length === 0 ? null : {
    unit: byPoints ? 'points' as const : 'tasks' as const,
    committed: weigh(committed),
    delivered: weigh(committed.filter((t) => deliveredIds.has(t.id))),
  }

  return { stats, endedAt, held, committed, added, delivered, leftover, removed, arrivedDone, sayDo }
}

/** Where one unfinished task went when its sprint closed, in a few words. */
function whereItWent(l: Leftover, sprint: Sprint, sprintName: (id: ID) => string): string {
  if (l.movedTo === undefined) return `left in ${sprint.name}`
  return l.movedTo === null ? 'back to the backlog' : `carried into ${sprintName(l.movedTo)}`
}

/** "2 carried into Sprint 5", "1 back to the backlog". */
function destinations(leftover: Leftover[], sprint: Sprint, sprintName: (id: ID) => string): string[] {
  const counts = new Map<string, number>()
  for (const l of leftover) {
    const where = whereItWent(l, sprint, sprintName)
    counts.set(where, (counts.get(where) ?? 0) + 1)
  }
  return [...counts].map(([where, n]) => `${n} ${where}`)
}

type Run = string | { b: string }
type Block = { h2: string } | { h3: string } | { p: Run[] } | { ul: Run[][] }

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function toMarkdown(blocks: Block[]): string {
  const runs = (rs: Run[]) => rs.map((r) => (typeof r === 'string' ? r : `**${r.b}**`)).join('')
  return `${blocks.map((b) => {
    if ('h2' in b) return `## ${b.h2}`
    if ('h3' in b) return `### ${b.h3}`
    if ('p' in b) return runs(b.p)
    return b.ul.map((item) => `- ${runs(item)}`).join('\n')
  }).join('\n\n')}\n`
}

function toHtml(blocks: Block[]): string {
  const runs = (rs: Run[]) => rs.map((r) => (typeof r === 'string' ? escapeHtml(r) : `<strong>${escapeHtml(r.b)}</strong>`)).join('')
  return blocks.map((b) => {
    if ('h2' in b) return `<h2>${escapeHtml(b.h2)}</h2>`
    if ('h3' in b) return `<h3>${escapeHtml(b.h3)}</h3>`
    if ('p' in b) return `<p>${runs(b.p)}</p>`
    return `<ul>${b.ul.map((item) => `<li>${runs(item)}</li>`).join('')}</ul>`
  }).join('\n')
}

/**
 * The report as something to paste: Markdown, plus the same thing as HTML for
 * the places that format a paste rather than show its asterisks. Teams,
 * Confluence and email all do; anywhere plain text takes the Markdown.
 *
 * Team-level on purpose: no names, and nothing from the retro. A sprint report
 * travels further than the team, and the retro is the team's own room.
 */
export function reportCopy({ sprint, teamName, report: r, statusName, sprintName }: {
  sprint: Sprint
  teamName: string | null
  report: SprintReportData
  statusName: (id: ID) => string
  sprintName: (id: ID) => string
}): { markdown: string; html: string } {
  const closed = r.endedAt !== null
  const byPoints = r.stats.burndownUnit === 'points'
  const addedIds = new Set(r.added.map((t) => t.id))
  const line = (t: Task) => {
    const points = pointsOf(t)
    return `${t.key} ${t.title.replace(/\s+/g, ' ')}${byPoints && points ? ` (${plural(points, 'pt')})` : ''}`
  }

  const when = [`${formatDate(sprint.startDate)} – ${formatDate(sprint.endDate)}`, plural(r.stats.dayCount, 'working day')]
  if (r.endedAt !== null) when.push(`closed ${formatDate(r.endedAt)}`)
  else if (sprint.state === 'active') when.push(`running, day ${r.stats.dayIndex} of ${r.stats.dayCount}`)

  const delivered = byPoints
    ? `${num(pointsIn(r.delivered))} of ${plural(r.stats.points, 'point')} (${r.delivered.length} of ${plural(r.held.length, 'task')})`
    : `${r.delivered.length} of ${plural(r.held.length, 'task')}`
  const sayDo = r.sayDo
    ? `${Math.round((r.sayDo.delivered / r.sayDo.committed) * 100)}% — ${num(r.sayDo.delivered)} of the `
      + `${plural(r.sayDo.committed, r.sayDo.unit === 'points' ? 'point' : 'task')} committed on day one `
      + `${closed ? 'were delivered' : 'done so far'}`
    : 'nothing was in it by the end of the first day to measure against'
  const left = r.leftover.map((l) => l.task)
  const leftLine = !closed
    ? `${plural(left.length, 'task')}${byPoints ? `, ${plural(pointsIn(left), 'point')}` : ''}`
    : left.length ? destinations(r.leftover, sprint, sprintName).join(', ') : 'nothing, everything it held was delivered'

  const blocks: Block[] = [
    { h2: teamName ? `${teamName} · ${sprint.name}` : sprint.name },
    { p: [when.join(' · ')] },
    { p: [{ b: 'Goal:' }, ` ${sprint.goal.trim() || 'none was set'}`] },
    {
      ul: [
        [{ b: closed ? 'Delivered:' : 'Delivered so far:' }, ` ${delivered}`],
        [{ b: 'Say/do:' }, ` ${sayDo}`],
        [{ b: 'Scope:' }, ` ${plural(r.committed.length, 'task')} committed on day one, `
          + `${r.added.length} added after it started, ${r.removed.length} taken out`],
        [{ b: closed ? 'Not finished:' : 'Still open:' }, ` ${leftLine}`],
      ],
    },
  ]
  if (r.delivered.length) {
    blocks.push(
      { h3: `${closed ? 'Delivered' : 'Delivered so far'} (${r.delivered.length})` },
      { ul: r.delivered.map((t) => [`${line(t)}${addedIds.has(t.id) ? ' — added after it started' : ''}`]) },
    )
  }
  if (r.leftover.length) {
    blocks.push(
      { h3: `${closed ? 'Not finished' : 'Still open'} (${r.leftover.length})` },
      {
        ul: r.leftover.map((l) =>
          [`${line(l.task)} — ${statusName(l.statusId)}${closed ? `, ${whereItWent(l, sprint, sprintName)}` : ''}`]),
      },
    )
  }
  if (r.removed.length) {
    blocks.push(
      { h3: `Taken out (${r.removed.length})` },
      { ul: r.removed.map((x) => [`${line(x.task)} — taken out ${formatDate(x.at)}`]) },
    )
  }
  return { markdown: toMarkdown(blocks), html: toHtml(blocks) }
}

/**
 * One task in a report list. Opens the task drawer, like every task row in the
 * app. On a narrow screen the chips wrap under the title rather than squeeze
 * it down to its first word.
 */
function TaskLine({ task, person, points, tone, children }: {
  task: Task
  person: Person | null
  /** Null hides the column, for a sprint nobody sized. */
  points: number | null
  tone?: string
  children?: React.ReactNode
}) {
  return (
    <button className="attn" style={{ flexWrap: 'wrap', rowGap: 5, borderLeftColor: tone }} onClick={() => setParam('task', task.id)}>
      <Avatar person={person} size={20} />
      <span className="attn-title" style={{ minWidth: 140 }}><span className="task-key">{task.key}</span> {task.title}</span>
      {children}
      {points !== null && (
        <span className="small faint" style={{ width: 34, flex: 'none', textAlign: 'right' }}>{points ? `${num(points)}p` : '–'}</span>
      )}
    </button>
  )
}

function ScopeLine({ label, tasks, byPoints }: { label: string; tasks: Task[]; byPoints: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ flex: 1 }}>{label}</span>
      <b>{tasks.length}</b>
      {byPoints && <span className="small faint" style={{ width: 34, textAlign: 'right' }}>{num(pointsIn(tasks))}p</span>}
    </div>
  )
}

const listStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 7 }
const footStyle: React.CSSProperties = {
  marginTop: 10, marginBottom: 0, paddingTop: 9, borderTop: '1px solid var(--line)',
  display: 'flex', flexDirection: 'column', gap: 4,
}

/**
 * Any sprint's review, read back out of the history: the burndown and scope as
 * they stood when it closed, what it delivered, what it did not and where that
 * went. Works the same for the running sprint, as a report so far.
 */
export function SprintReport({
  sprint, sprints, tasks, statuses, statusEvents, sprintEvents, holidays, onBack, onRetro, onClose,
}: {
  sprint: Sprint
  /** The team's sprints, for naming where carried work went. */
  sprints: Sprint[]
  tasks: Task[]
  statuses: Status[]
  statusEvents: StatusEvent[]
  sprintEvents: SprintEvent[]
  holidays: readonly string[]
  onBack: () => void
  /** What the screen's Retro button does: finds the sprint's retro, or starts one. */
  onRetro: () => void
  /** Offered while the sprint is running. */
  onClose?: () => void
}) {
  const toast = useToast()
  const [manual, setManual] = useState<string | null>(null)
  // Everyone, not only who is active: a closed sprint is history, and some of
  // the people in it may have moved on since.
  const people = useLiveQuery(() => db.people.toArray(), [], [] as Person[])
  const team = useLiveQuery(() => db.teams.get(sprint.teamId), [sprint.teamId])
  // Looked up, never made — notes.retroFor would start one just by asking.
  // Undefined while looking, null once it is known there is none.
  const retro = useLiveQuery(
    async () => (await db.notes.where('sprintId').equals(sprint.id)
      .filter((n) => n.type === 'retro' && n.teamId === sprint.teamId)
      .first()) ?? null,
    [sprint.id, sprint.teamId],
  )

  const r = sprintReport(sprint, tasks, statusEvents, sprintEvents, statuses, { holidays })
  const { stats } = r
  const closed = r.endedAt !== null
  const byPoints = stats.burndownUnit === 'points'
  const unit = byPoints ? 'point' : 'task'
  const weigh = (list: Task[]) => (byPoints ? pointsIn(list) : list.length)
  const byPerson = new Map(people.map((p) => [p.id, p]))
  const personOf = (t: Task) => (t.assigneeId ? byPerson.get(t.assigneeId) ?? null : null)
  const statusName = (id: ID) => statuses.find((s) => s.id === id)?.name ?? '?'
  const sprintName = (id: ID) => sprints.find((s) => s.id === id)?.name ?? 'a deleted sprint'
  const addedIds = new Set(r.added.map((t) => t.id))
  const left = r.leftover.map((l) => l.task)
  const sayDoPct = r.sayDo ? Math.round((r.sayDo.delivered / r.sayDo.committed) * 100) : null
  const retroLines = (retro?.body ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (l.length > 180 ? `${l.slice(0, 179)}…` : l))

  async function copy() {
    const text = reportCopy({ sprint, teamName: team?.name ?? null, report: r, statusName, sprintName })
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text.markdown], { type: 'text/plain' }),
        'text/html': new Blob([text.html], { type: 'text/html' }),
      })])
      toast('Report copied — paste it into Teams, Confluence or an email')
    } catch {
      // Some clipboards take plain text only, and some not even that.
      try {
        await navigator.clipboard.writeText(text.markdown)
        toast('Report copied as Markdown')
      } catch {
        setManual(text.markdown)
      }
    }
  }

  return (
    <>
      <div className="topbar">
        <button className="btn ghost sm" onClick={onBack}>← Sprints</button>
        <h1>{sprint.name}</h1>
        <span className={`chip${sprint.state === 'active' ? ' on' : closed ? ' solid' : ''}`}>{sprint.state}</span>
        <span className="spacer" />
        {sprint.state !== 'planned' && (
          <button className={`btn${onClose ? '' : ' primary'}`} onClick={() => void copy()}>Copy report</button>
        )}
        {onClose && <button className="btn primary" onClick={onClose}>Close {sprint.name}</button>}
      </div>

      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 940 }}>
        <div className="panel">
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <span className="label">Goal</span>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
                {sprint.goal.trim() || <span className="faint" style={{ fontWeight: 400 }}>No goal was set.</span>}
              </div>
              <div className="small faint" style={{ marginTop: 10 }}>
                {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)} · {plural(stats.dayCount, 'working day')}
                {closed
                  ? ` · closed ${formatDate(r.endedAt)}`
                  : sprint.state === 'active' ? ` · day ${stats.dayIndex} of ${stats.dayCount}` : ' · not started'}
              </div>
            </div>
            {sprint.state !== 'planned' && (
              <>
                <div style={{ textAlign: 'right' }}>
                  <div className="kpi-n">
                    {num(weigh(r.delivered))}<span className="faint" style={{ fontSize: 14 }}>/{num(weigh(r.held))}</span>
                  </div>
                  <div className="small faint">{unit}s delivered</div>
                </div>
                <div style={{ textAlign: 'right' }} title="Of the work in it by the end of its first day, how much was delivered">
                  <div className="kpi-n">{sayDoPct === null ? '—' : `${sayDoPct}%`}</div>
                  <div className="small faint">say/do</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="kpi-n">{r.leftover.length}</div>
                  <div className="small faint">{closed ? 'not finished' : 'still open'}</div>
                </div>
              </>
            )}
          </div>
        </div>

        {sprint.state === 'planned' ? (
          <div className="empty">
            <strong>Not started yet</strong>
            {plural(r.held.length, 'task')} in it so far. Once it runs this fills in: the burndown, what it delivered and
            where the rest went.
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => go('planning', { sprint: sprint.id })}>Plan it</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
              <div className="panel" style={{ flex: 1.5, minWidth: 280 }}>
                <p className="panel-title">Burndown<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>{stats.burndownUnit} · working days</span></p>
                <Burndown series={stats.series} until={r.endedAt === null ? undefined : todayISO(new Date(r.endedAt))} />
                <p className="small faint" style={{ margin: '6px 0 0' }}>
                  {!closed
                    ? 'Replayed from the move history, as it stands right now.'
                    : left.length === 0
                      ? 'Burned all the way down: everything it held when it closed was done.'
                      : `It closed with ${plural(weigh(left), unit)} still open. Where each one went is below.`}
                  {byPoints
                    ? ' A task with no size adds no points, same as velocity.'
                    : ' Nothing in this sprint is sized, so it burns down tasks instead of points.'}
                </p>
              </div>
              <div className="panel" style={{ flex: 1, minWidth: 210 }}>
                <p className="panel-title">Scope</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <ScopeLine label="Committed" tasks={r.committed} byPoints={byPoints} />
                  <ScopeLine label="Added after it started" tasks={r.added} byPoints={byPoints} />
                  <ScopeLine label="Taken out" tasks={r.removed.map((x) => x.task)} byPoints={byPoints} />
                </div>
                <div className="small faint" style={footStyle}>
                  <span>
                    {r.sayDo === null
                      ? 'Nothing was in it by the end of the first day, so there is no commitment to measure say/do against.'
                      : `Say/do ${sayDoPct}%: ${num(r.sayDo.delivered)} of the `
                        + `${plural(r.sayDo.committed, r.sayDo.unit === 'points' ? 'point' : 'task')} committed on day one `
                        + `${closed ? 'were delivered' : 'are done so far'}.`}
                  </span>
                  {r.committed.length > 0 && r.added.length > 0 && (
                    <span>Scope grew {Math.round((r.added.length / r.committed.length) * 100)}% after day one.</span>
                  )}
                </div>
              </div>
            </div>

            <div className="panel">
              <p className="panel-title">
                {closed ? 'Delivered' : 'Delivered so far'}
                <span className="spacer" />
                <span className="faint" style={{ fontWeight: 400 }}>
                  {plural(r.delivered.length, 'task')}{byPoints ? ` · ${plural(pointsIn(r.delivered), 'point')}` : ''}
                </span>
              </p>
              {r.delivered.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  {closed ? 'Nothing was finished while it belonged to this sprint.' : 'Nothing finished in it yet.'}
                </p>
              ) : (
                <div style={listStyle}>
                  {r.delivered.map((t) => (
                    <TaskLine key={t.id} task={t} person={personOf(t)} points={byPoints ? pointsOf(t) : null} tone="var(--ok)">
                      {addedIds.has(t.id) && <span className="chip" title="Joined after the first day">added</span>}
                    </TaskLine>
                  ))}
                </div>
              )}
              {r.arrivedDone.length > 0 && (
                <p className="small faint" style={footStyle}>
                  {r.arrivedDone.length === 1
                    ? '1 more was already done when it joined, so it counts where it was finished, not here.'
                    : `${r.arrivedDone.length} more were already done when they joined, so they count where they were finished, not here.`}
                </p>
              )}
            </div>

            <div className="panel">
              <p className="panel-title">
                {closed ? 'Not finished' : 'Still open'}
                <span className="spacer" />
                <span className="faint" style={{ fontWeight: 400 }}>
                  {closed
                    ? destinations(r.leftover, sprint, sprintName).join(' · ')
                    : `${plural(left.length, 'task')}${byPoints ? ` · ${plural(pointsIn(left), 'point')}` : ''}`}
                </span>
              </p>
              {r.leftover.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  {closed ? 'Nothing. Everything it held when it closed was delivered.' : 'Nothing open. Everything in it is done.'}
                </p>
              ) : (
                <div style={listStyle}>
                  {r.leftover.map((l) => (
                    <TaskLine key={l.task.id} task={l.task} person={personOf(l.task)} points={byPoints ? pointsOf(l.task) : null}>
                      {addedIds.has(l.task.id) && <span className="chip" title="Joined after the first day">added</span>}
                      <span className="chip" title={closed ? 'Where it was when the sprint closed' : undefined}>{statusName(l.statusId)}</span>
                      {closed && (
                        <span className="chip solid" title={l.movedTo === undefined ? 'Still sits in this closed sprint' : undefined}>
                          {l.movedTo === undefined ? 'left here' : l.movedTo === null ? '→ backlog' : `→ ${sprintName(l.movedTo)}`}
                        </span>
                      )}
                    </TaskLine>
                  ))}
                </div>
              )}
            </div>

            {r.removed.length > 0 && (
              <div className="panel">
                <p className="panel-title">
                  Taken out
                  <span className="spacer" />
                  <span className="faint" style={{ fontWeight: 400 }}>
                    {plural(r.removed.length, 'task')}{byPoints ? ` · ${plural(pointsIn(r.removed.map((x) => x.task)), 'point')}` : ''}
                  </span>
                </p>
                <div style={listStyle}>
                  {r.removed.map(({ task, at }) => (
                    <TaskLine key={task.id} task={task} person={personOf(task)} points={byPoints ? pointsOf(task) : null}>
                      <span className="small faint" style={{ flex: 'none' }}>{formatDate(at)}</span>
                    </TaskLine>
                  ))}
                </div>
              </div>
            )}

            <div className="panel">
              <p className="panel-title">
                Retro
                {retro && <><span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>updated {formatDate(retro.updatedAt)}</span></>}
              </p>
              {retro === null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ flex: 1 }}>No retro written for {sprint.name} yet.</span>
                  <button className="btn sm" onClick={onRetro}>Start the retro</button>
                </div>
              )}
              {retro && (
                <>
                  <button className="linkish" onClick={() => go('notes', { note: retro.id })}>{retro.title}</button>
                  {retroLines.length > 0 && (
                    <p className="small muted" style={{ margin: '6px 0 0', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
                      {retroLines.slice(0, 4).join('\n')}{retroLines.length > 4 ? '\n…' : ''}
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {manual !== null && (
        <>
          <div className="scrim" onClick={() => setManual(null)} />
          <div className="modal" style={{ maxWidth: 620 }}>
            <div className="modal-head"><b>Copy the report</b><span className="spacer" />
              <button className="btn ghost sm" onClick={() => setManual(null)}>Done</button>
            </div>
            <div className="modal-body">
              <p className="small muted" style={{ marginTop: 0 }}>
                This window is not allowed to use the clipboard, so here it is to copy by hand.
              </p>
              <textarea className="textarea" readOnly value={manual} rows={16} autoFocus
                onFocus={(e) => e.currentTarget.select()}
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 }} />
            </div>
          </div>
        </>
      )}
    </>
  )
}
