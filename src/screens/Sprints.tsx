import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { Burndown } from '../components/Burndown'
import { SprintReport, sprintReport } from '../components/SprintReport'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { ID, Sprint, Task } from '../db/types'
import { go, setParam, useRoute } from '../hooks/useRoute'
import { DateField } from '../components/DateField'
import { formatDate } from '../lib/dates'
import {
  blockers as blockerRepo, buildIndex, daysInStatus, flowStats, isStuckTask, notes as notesRepo,
  settings as settingsRepo, sprints as repo, tasks as taskRepo, velocity, workingDays, type BoardIndex,
} from '../repo'

/**
 * Closing is where the sprint's leftovers get sorted: whatever is ticked
 * carries into the next sprint, whatever is unticked goes back to the backlog.
 *
 * Declared out here rather than inside the screen, which re-renders on every
 * database write: nested, it would be a new component each time and lose its ticks.
 */
function CloseDialog({ sprint, unfinished, next, ix, onPlanNext, onCancel, onClosed }: {
  sprint: Sprint
  unfinished: Task[]
  /** The planned sprint to carry into, if there is one. */
  next: Sprint | null
  ix: BoardIndex
  /** Plans the sprint after this one, for when there is nothing to carry into. */
  onPlanNext: () => Promise<Sprint>
  onCancel: () => void
  onClosed: (message: string) => void
}) {
  const toast = useToast()
  // What stays behind rather than what carries, so anything that turns
  // unfinished while this is open carries like the rest.
  const [dropping, setDropping] = useState<ReadonlySet<ID>>(() => new Set())
  // Held still while the moves land, or the list empties under the buttons.
  const [inFlight, setInFlight] = useState<Task[] | null>(null)
  const open = inFlight ?? unfinished
  const carry = open.filter((t) => !dropping.has(t.id))
  const drop = open.filter((t) => dropping.has(t.id))

  function toggle(id: ID) {
    setDropping((prev) => {
      const out = new Set(prev)
      if (out.has(id)) out.delete(id)
      else out.add(id)
      return out
    })
  }

  async function close(dropAll: boolean) {
    if (inFlight) return
    setInFlight(open)
    const carried = dropAll ? [] : carry
    const dropped = dropAll ? open : drop
    try {
      const planned = carried.length > 0 && !next
      const into = carried.length ? next ?? await onPlanNext() : null
      /*
       * Close first, then take the dropped ones out. Closing stamps closedAt,
       * and only a move out before that counts as scope taken out of the
       * sprint. Leftovers sorted at the end are not work anyone pulled.
       */
      await repo.close(sprint.id, into?.id ?? null, (into ? carried : dropped).map((t) => t.id))
      if (into) for (const t of dropped) await taskRepo.setSprint(t.id, null)

      const parts: string[] = []
      if (into) {
        parts.push(planned
          ? `${into.name} planned for ${formatDate(into.startDate)} with ${carried.length} carried in`
          : `${carried.length} carried into ${into.name}`)
      }
      if (dropped.length) parts.push(`${dropped.length} back to the backlog`)
      onClosed(`${sprint.name} closed${parts.length ? `, ${parts.join(', ')}` : ''}`)
    } catch {
      toast(`Could not close ${sprint.name}`, true)
      setInFlight(null)
    }
  }

  const dropAllLabel = open.length === 1 ? 'Close and drop it' : `Close and drop all ${open.length}`
  const primary = open.length === 0 ? `Close ${sprint.name}`
    : carry.length === 0 ? dropAllLabel
      : next ? `Close and carry ${carry.length} over`
        : `Plan the next sprint and carry ${carry.length} into it`
  const where = [
    carry.length ? `${carry.length} into ${next ? next.name : 'a new sprint'}` : '',
    drop.length ? `${drop.length} back to the backlog` : '',
  ].filter(Boolean).join(' · ')

  return (
    <>
      <div className="scrim" onClick={inFlight ? undefined : onCancel} />
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-head"><b>Close {sprint.name}</b><span className="spacer" />
          <button className="btn ghost sm" disabled={!!inFlight} onClick={onCancel}>Cancel</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0 }}>
            {open.length === 0
              ? 'Everything in this sprint is done. Nothing to carry.'
              : `${open.length} task${open.length === 1 ? '' : 's'} unfinished. Ticked ones carry into ${next ? next.name : 'the next sprint'}; `
                + 'untick any that should go back to the backlog instead. Each move is logged.'}
          </p>
          {open.length > 0 && (
            <>
              <label className="small faint" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 7px 6px', cursor: 'pointer', width: 'fit-content' }}>
                <input type="checkbox" checked={drop.length === 0}
                  ref={(el) => { if (el) el.indeterminate = carry.length > 0 && drop.length > 0 }}
                  onChange={() => setDropping(drop.length === 0 ? new Set(open.map((t) => t.id)) : new Set())} />
                Carry {carry.length} of {open.length}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                {open.map((t) => {
                  const carried = !dropping.has(t.id)
                  return (
                    <label key={t.id} className="paste-row" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={carried} onChange={() => toggle(t.id)} />
                      <Avatar person={t.assigneeId ? ix.byPerson.get(t.assigneeId) ?? null : null} size={18} dim={!carried} />
                      <span style={{ flex: 1, color: carried ? undefined : 'var(--faint)' }}>{t.title}</span>
                      {!carried && <span className="chip">back to the backlog</span>}
                      <span className="chip">{ix.byStatus.get(t.statusId)?.name}</span>
                    </label>
                  )
                })}
              </div>
            </>
          )}
          {!next && carry.length > 0 && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              No sprint is planned to carry them into yet, so closing plans the next one first, with the sprint length
              and start day from Settings.
            </p>
          )}
        </div>
        <div className="modal-foot">
          <span className="small faint">{where || 'Nothing to carry'}</span>
          <span className="spacer" />
          {carry.length > 0 && (
            <button className="btn" disabled={!!inFlight} onClick={() => void close(true)}>{dropAllLabel}</button>
          )}
          <button className="btn primary" disabled={!!inFlight} onClick={() => void close(false)}>{primary}</button>
        </div>
      </div>
    </>
  )
}

export function Sprints({ teamId }: { teamId: string }) {
  const toast = useToast()
  const route = useRoute()
  const [closing, setClosing] = useState<Sprint | null>(null)

  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const list = useLiveQuery(() => repo.listForTeam(teamId), [teamId], [])
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useLiveQuery(() => db.people.filter((p) => p.active).sortBy('name'), [], [])
  const statusEvents = useLiveQuery(() => db.statusEvents.toArray(), [], [])
  const sprintEvents = useLiveQuery(() => db.sprintEvents.toArray(), [], [])
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])

  const ix = buildIndex(statuses, people, openBlockers)
  const holidays = cfg?.holidays ?? []
  const active = list.find((s) => s.state === 'active') ?? null
  // The same reading as the running sprint's report, so the two never disagree.
  const activeReport = active ? sprintReport(active, tasks, statusEvents, sprintEvents, statuses, { holidays }) : null
  const stats = activeReport?.stats ?? null
  // A report opened from the list. Kept in the address so Back closes it again.
  const shown = list.find((s) => s.id === route.params.get('sprint')) ?? null

  const outcomes = velocity(list.filter((s) => s.state === 'closed'), tasks, statusEvents, statuses)
  const outcomeOf = new Map(outcomes.map((o) => [o.sprintId, o]))
  // Last six closed sprints, oldest first, so the bars read left to right.
  const past = outcomes.slice(-6)
  const delivered = past.filter((p) => p.tasks > 0)
  const averageVelocity = delivered.length
    ? Math.round(delivered.reduce((sum, p) => sum + p.points, 0) / delivered.length)
    : null
  // Last 60 days, so a change in how the team works shows up instead of being
  // averaged away by six months of history.
  const flow = flowStats(tasks, statusEvents, ix, Date.now() - 60 * 86_400_000)

  const inSprint = active ? tasks.filter((t) => t.sprintId === active.id) : []
  const atRisk = inSprint.filter((t) =>
    !ix.doneIds.has(t.statusId) && (ix.blockerByTask.has(t.id) || isStuckTask(t, ix)))
  const unfinished = inSprint.filter((t) => !ix.doneIds.has(t.statusId))
  const nextPlanned = list.find((s) => s.state === 'planned') ?? null

  /**
   * Every sprint edit goes through here so a refusal says why and puts the
   * field back, rather than leaving a rejected date sitting on screen looking
   * as though it saved.
   */
  async function save(
    id: string,
    patch: Parameters<typeof repo.update>[1],
    el?: HTMLInputElement,
    revertTo?: string,
  ) {
    const r = await repo.update(id, patch)
    if (!r.ok) {
      toast(r.reason ?? 'Could not save that', true)
      if (el && revertTo !== undefined) el.value = revertTo
    }
  }

  /** The sprint after the last one, with the length and start day from Settings. */
  const planNextSprint = () => repo.plan({
    teamId,
    lengthDays: cfg?.sprintLengthDays ?? 14,
    startWeekday: cfg?.sprintStartWeekday ?? 1,
  })

  async function planNext() {
    const s = await planNextSprint()
    toast(`${s.name} planned for ${formatDate(s.startDate)}`)
  }

  /** Finds the sprint's retro, or starts it, and opens it. */
  async function openRetro(s: Sprint) {
    const note = await notesRepo.retroFor(teamId, s)
    go('notes', { note: note.id })
  }

  const dialog = closing && (
    <CloseDialog key={closing.id} sprint={closing} unfinished={unfinished} next={nextPlanned} ix={ix}
      onPlanNext={planNextSprint} onCancel={() => setClosing(null)}
      onClosed={(message) => {
        setClosing(null)
        toast(message)
        // Straight to what it delivered, which is the next thing anyone asks.
        setParam('sprint', closing.id)
      }} />
  )

  if (shown) {
    return (
      <>
        <SprintReport sprint={shown} sprints={list} tasks={tasks} statuses={statuses}
          statusEvents={statusEvents} sprintEvents={sprintEvents} holidays={holidays}
          onBack={() => setParam('sprint', null)} onRetro={() => void openRetro(shown)}
          onClose={shown.state === 'active' ? () => setClosing(shown) : undefined} />
        {dialog}
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <h1>Sprints</h1>
        {active && <span className="chip on">{active.name}</span>}
        <span className="spacer" />
        <button className="btn" onClick={planNext}>Plan another</button>
        {active && <button className="btn" onClick={() => void openRetro(active)}>Retro</button>}
        {active && <button className="btn primary" onClick={() => setClosing(active)}>Close {active.name}</button>}
      </div>

      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 940 }}>
        {!active ? (
          <div className="empty">
            <strong>No sprint running</strong>
            Plan one, pull work into it on Sprint planning, then start it. Every join is logged so the chart can tell
            what was committed up front from what turned up on day six.
          </div>
        ) : (
          <>
            <div className="panel">
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <span className="label">Name</span>
                  {/* The saved value is part of the key, so renaming from the list
                      below re-syncs this field instead of leaving it showing the
                      old name. */}
                  <input className="inline-input" style={{ fontSize: 15, fontWeight: 650, marginTop: 2 }}
                    key={`${active.id}-name-${active.name}`} defaultValue={active.name}
                    onBlur={(e) => void save(active.id, { name: e.target.value }, e.target, active.name)} />

                  <span className="label" style={{ marginTop: 10, display: 'block' }}>Goal</span>
                  <input className="inline-input" style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}
                    key={`${active.id}-goal-${active.goal}`} defaultValue={active.goal} placeholder="One sentence the team can recite on day six"
                    onBlur={(e) => void save(active.id, { goal: e.target.value })} />

                  <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    <DateField label="Sprint start" style={{ width: 166 }} value={active.startDate}
                      onCommit={(iso) => { if (iso) void save(active.id, { startDate: iso }) }} />
                    <span className="small faint">to</span>
                    <DateField label="Sprint end" style={{ width: 166 }} value={active.endDate}
                      onCommit={(iso) => { if (iso) void save(active.id, { endDate: iso }) }} />
                    <span className="small faint">
                      day {stats!.dayIndex} of {stats!.dayCount} working day{stats!.dayCount === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="kpi-n">{stats!.done}<span className="faint" style={{ fontSize: 14 }}>/{stats!.total}</span></div>
                  <div className="small faint">done</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="kpi-n">{stats!.pointsDone}<span className="faint" style={{ fontSize: 14 }}>/{stats!.points}</span></div>
                  <div className="small faint">points</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="kpi-n" style={{ color: atRisk.length ? 'var(--alert)' : undefined }}>{atRisk.length}</div>
                  <div className="small faint">at risk</div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
              <div className="panel" style={{ flex: 1.5, minWidth: 280 }}>
                <p className="panel-title">Burndown<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>{stats!.burndownUnit} · working days</span></p>
                <Burndown series={stats!.series} />
                <p className="small faint" style={{ margin: '6px 0 0' }}>
                  Replayed from the move history, so it is right even for sprints that ran before this screen existed.
                  {stats!.burndownUnit === 'points'
                    ? ' A task with no size adds no points, same as velocity.'
                    : ' Nothing in this sprint is sized yet, so it burns down tasks instead of points.'}
                </p>
              </div>
              <div className="panel" style={{ flex: 1, minWidth: 190 }}>
                <p className="panel-title">Scope</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex' }}><span style={{ flex: 1 }}>Committed</span><b>{stats!.committed}</b></div>
                  <div style={{ display: 'flex' }}><span style={{ flex: 1 }}>Added after it started</span><b>{stats!.addedAfterStart}</b></div>
                  <div style={{ display: 'flex' }}><span style={{ flex: 1 }}>Taken out</span><b>{activeReport!.removed.length}</b></div>
                </div>
                {stats!.committed > 0 && stats!.addedAfterStart > 0 && (
                  <p className="small faint" style={{ marginTop: 10, marginBottom: 0, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
                    Scope grew {Math.round((stats!.addedAfterStart / stats!.committed) * 100)}% after day one.
                  </p>
                )}
              </div>
            </div>

            <div className="panel">
              <p className="panel-title">
                Likely to carry over
                <span className="spacer" />
                <span className="faint" style={{ fontWeight: 400 }}>{atRisk.length} of {unfinished.length} unfinished</span>
              </p>
              {atRisk.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Nothing blocked or sitting still. On the evidence so far, this sprint lands.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {atRisk.map((t) => {
                    const b = ix.blockerByTask.get(t.id)
                    return (
                      <button key={t.id} className="attn hot" onClick={() => setParam('task', t.id)}>
                        <Avatar person={t.assigneeId ? ix.byPerson.get(t.assigneeId) ?? null : null} size={20} />
                        <span className="attn-title">
                          {t.title}
                          <span className="faint"> · {b ? `blocked ${b.reason}` : `${daysInStatus(t)} days without moving`}</span>
                        </span>
                        <span className="chip">{ix.byStatus.get(t.statusId)?.name}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {list.length > 0 && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div className="panel" style={{ flex: 1.5, minWidth: 280 }}>
              <p className="panel-title">
                Velocity
                <span className="spacer" />
                <span className="faint" style={{ fontWeight: 400 }}>points delivered per sprint</span>
              </p>
              {past.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Close a sprint and what it actually delivered lands here. Read from the move history, so it counts
                  what finished while the sprint was running rather than what happens to still be sitting in it.
                </p>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {past.map((p) => {
                      const max = Math.max(1, ...past.map((x) => x.points))
                      return (
                        <div key={p.sprintId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <button className="linkish" title={`Open ${p.name}'s report`} onClick={() => setParam('sprint', p.sprintId)}
                            style={{ width: 74, fontSize: 11.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.name}
                          </button>
                          <span className="bar" style={{ flex: 1 }}>
                            <i style={{ width: `${(p.points / max) * 100}%` }} />
                          </span>
                          <span className="small faint" style={{ width: 62, textAlign: 'right' }}>
                            {p.points}p · {p.tasks}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  {averageVelocity != null && (
                    <p className="small faint" style={{ marginTop: 10, marginBottom: 0, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
                      Averaging {averageVelocity} point{averageVelocity === 1 ? '' : 's'} a sprint
                      {stats && stats.points > averageVelocity * 1.25
                        ? ` — this one holds ${stats.points}, which is more than the team has finished in any recent sprint.`
                        : '. Worth planning the next one against that number rather than against hope.'}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="panel" style={{ flex: 1, minWidth: 190 }}>
              <p className="panel-title">Cycle time<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>60 days</span></p>
              {flow.sampled === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  Nothing has finished in the last sixty days, so there is nothing to measure yet.
                </p>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 18 }}>
                    <div>
                      <div className="kpi-n">{flow.medianDays?.toFixed(1)}<span className="faint" style={{ fontSize: 13 }}>d</span></div>
                      <div className="small faint">typical</div>
                    </div>
                    <div>
                      <div className="kpi-n">{flow.p85Days?.toFixed(1)}<span className="faint" style={{ fontSize: 13 }}>d</span></div>
                      <div className="small faint">slow tail</div>
                    </div>
                  </div>
                  <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
                    From the moment work actually started to the moment it was done, across {flow.sampled} finished
                    task{flow.sampled === 1 ? '' : 's'}. Time sitting in the backlog is not counted.
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        <div className="panel" style={{ padding: 0 }}>
          <p className="panel-title" style={{ padding: '12px 14px 8px', margin: 0 }}>All sprints</p>
          {list.length === 0 && <p className="small faint" style={{ padding: '0 14px 14px', margin: 0 }}>None yet.</p>}
          {[...list].reverse().map((s) => {
            const count = tasks.filter((t) => t.sprintId === s.id).length
            const done = tasks.filter((t) => t.sprintId === s.id && ix.doneIds.has(t.statusId)).length
            // A closed sprint holds only what it finished, because closing carried
            // the rest out, so "X of Y done" would read as a clean sweep every time.
            const outcome = outcomeOf.get(s.id)
            const summary = outcome
              ? `${outcome.tasks} delivered${outcome.points ? `, ${outcome.points} points` : ''}`
              : `${done} of ${count} done`
            return (
              <div key={s.id} className="row" style={{ borderTop: '1px solid var(--line)' }}>
                <input className="inline-input" style={{ width: 104, fontWeight: 600 }}
                  key={`${s.id}-${s.name}`} defaultValue={s.name}
                  onBlur={(e) => void save(s.id, { name: e.target.value }, e.target, s.name)} />
                <span className={`chip${s.state === 'active' ? ' on' : s.state === 'closed' ? ' solid' : ''}`}>{s.state}</span>
                <DateField label={`${s.name} start`} style={{ width: 162 }} value={s.startDate}
                  onCommit={(iso) => { if (iso) void save(s.id, { startDate: iso }) }} />
                <span className="small faint">to</span>
                <DateField label={`${s.name} end`} style={{ width: 162 }} value={s.endDate}
                  onCommit={(iso) => { if (iso) void save(s.id, { endDate: iso }) }} />
                <span className="small faint" style={{ flex: 1 }}>
                  {workingDays(s.startDate, s.endDate, holidays).length}d · {summary}
                </span>
                {s.state !== 'closed' && (
                  <button className="btn ghost sm" onClick={() => go('planning', { sprint: s.id })}>Plan</button>
                )}
                {s.state !== 'planned' && (
                  <button className={`btn sm${s.state === 'closed' ? '' : ' ghost'}`} onClick={() => setParam('sprint', s.id)}>Report</button>
                )}
                {s.state !== 'planned' && (
                  <button className="btn ghost sm" onClick={() => void openRetro(s)}>Retro</button>
                )}
                {s.state === 'planned' && (
                  <button className="btn sm" onClick={async () => {
                    const r = await repo.activate(s.id)
                    if (!r.ok) toast(r.reason ?? 'Could not start it', true)
                  }}>Start</button>
                )}
                {s.state !== 'active' && (
                  <button className="btn ghost sm" onClick={async () => {
                    if (!confirm(`Delete ${s.name}? Its tasks stay, but lose their sprint.`)) return
                    await repo.remove(s.id)
                  }}>Delete</button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {dialog}
    </>
  )
}
