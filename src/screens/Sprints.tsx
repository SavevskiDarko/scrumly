import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Sprint } from '../db/types'
import { setParam } from '../hooks/useRoute'
import {
  blockers as blockerRepo, buildIndex, daysInStatus, flowStats, isStuckTask,
  settings as settingsRepo, sprints as repo, sprintStats, todayISO, velocity, workingDays,
} from '../repo'

function Burndown({ series }: { series: { date: string; remaining: number; ideal: number }[] }) {
  if (series.length < 2) return <p className="small faint" style={{ margin: 0 }}>Not enough days to chart.</p>
  const w = 300, h = 96, pad = 4
  const max = Math.max(1, ...series.map((p) => Math.max(p.remaining, p.ideal)))
  const x = (i: number) => pad + (i * (w - pad * 2)) / (series.length - 1)
  const y = (v: number) => pad + ((max - v) * (h - pad * 2)) / max
  // todayISO, not toISOString: the rest of the app works in local dates, and
  // west of UTC the two disagree for part of every evening.
  const todayIdx = series.findIndex((p) => p.date >= todayISO())
  const upto = todayIdx === -1 ? series.length : todayIdx + 1
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-label="Burndown">
      <polyline fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="4 4"
        points={series.map((p, i) => `${x(i)},${y(p.ideal)}`).join(' ')} />
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5"
        points={series.slice(0, upto).map((p, i) => `${x(i)},${y(p.remaining)}`).join(' ')} />
    </svg>
  )
}

export function Sprints({ teamId }: { teamId: string }) {
  const toast = useToast()
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
  const active = list.find((s) => s.state === 'active') ?? null
  const stats = active ? sprintStats(active, tasks, statusEvents, sprintEvents, statuses) : null

  // Last six closed sprints, oldest first, so the bars read left to right.
  const past = velocity(list.filter((s) => s.state === 'closed'), tasks, statusEvents, statuses).slice(-6)
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

  async function planNext() {
    const s = await repo.plan({
      teamId,
      lengthDays: cfg?.sprintLengthDays ?? 14,
      startWeekday: cfg?.sprintStartWeekday ?? 1,
    })
    toast(`${s.name} planned for ${s.startDate}`)
  }

  return (
    <>
      <div className="topbar">
        <h1>Sprints</h1>
        {active && <span className="chip on">{active.name}</span>}
        <span className="spacer" />
        <button className="btn" onClick={planNext}>Plan another</button>
        {active && <button className="btn primary" onClick={() => setClosing(active)}>Close {active.name}</button>}
      </div>

      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 940 }}>
        {!active ? (
          <div className="empty">
            <strong>No sprint running</strong>
            Plan one, then activate it. Tasks join a sprint from their detail panel, and every join is logged so the
            chart can tell what was committed up front from what turned up on day six.
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
                    <input className="input" type="date" style={{ width: 142 }} value={active.startDate}
                      onChange={(e) => void save(active.id, { startDate: e.target.value })} />
                    <span className="small faint">to</span>
                    <input className="input" type="date" style={{ width: 142 }} value={active.endDate}
                      onChange={(e) => void save(active.id, { endDate: e.target.value })} />
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
                <p className="panel-title">Burndown<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>points · working days</span></p>
                <Burndown series={stats!.series} />
                <p className="small faint" style={{ margin: '6px 0 0' }}>
                  Replayed from the move history, so it is right even for sprints that ran before this screen existed.
                  A task with no size counts as one point.
                </p>
              </div>
              <div className="panel" style={{ flex: 1, minWidth: 190 }}>
                <p className="panel-title">Scope</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex' }}><span style={{ flex: 1 }}>Committed</span><b>{stats!.committed}</b></div>
                  <div style={{ display: 'flex' }}><span style={{ flex: 1 }}>Added after it started</span><b>{stats!.addedAfterStart}</b></div>
                  <div style={{ display: 'flex' }}><span style={{ flex: 1 }}>Taken out</span><b>{stats!.removed}</b></div>
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
                          <span className="small" style={{ width: 74, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.name}
                          </span>
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
            return (
              <div key={s.id} className="row" style={{ borderTop: '1px solid var(--line)' }}>
                <input className="inline-input" style={{ width: 104, fontWeight: 600 }}
                  key={`${s.id}-${s.name}`} defaultValue={s.name}
                  onBlur={(e) => void save(s.id, { name: e.target.value }, e.target, s.name)} />
                <span className={`chip${s.state === 'active' ? ' on' : s.state === 'closed' ? ' solid' : ''}`}>{s.state}</span>
                <input className="input" type="date" style={{ width: 138 }} value={s.startDate}
                  onChange={(e) => void save(s.id, { startDate: e.target.value })} />
                <span className="small faint">to</span>
                <input className="input" type="date" style={{ width: 138 }} value={s.endDate}
                  onChange={(e) => void save(s.id, { endDate: e.target.value })} />
                <span className="small faint" style={{ flex: 1 }}>
                  {workingDays(s.startDate, s.endDate).length}d · {done} of {count} done
                </span>
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

      {closing && (
        <>
          <div className="scrim" onClick={() => setClosing(null)} />
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="modal-head"><b>Close {closing.name}</b><span className="spacer" />
              <button className="btn ghost sm" onClick={() => setClosing(null)}>Cancel</button>
            </div>
            <div className="modal-body">
              <p className="muted" style={{ marginTop: 0 }}>
                {unfinished.length === 0
                  ? 'Everything in this sprint is done. Nothing to carry.'
                  : `${unfinished.length} task${unfinished.length === 1 ? '' : 's'} unfinished. They can move to the next sprint, and each move is logged.`}
              </p>
              {unfinished.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                  {unfinished.map((t) => (
                    <div key={t.id} className="paste-row">
                      <Avatar person={t.assigneeId ? ix.byPerson.get(t.assigneeId) ?? null : null} size={18} />
                      <span style={{ flex: 1 }}>{t.title}</span>
                      <span className="chip">{ix.byStatus.get(t.statusId)?.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {!nextPlanned && unfinished.length > 0 && (
                <p className="small" style={{ color: 'var(--alert)', marginBottom: 0 }}>
                  No sprint planned to carry them into. They will come out of this sprint and sit unassigned to one.
                </p>
              )}
            </div>
            <div className="modal-foot">
              <span className="small faint">
                {nextPlanned ? `Carrying into ${nextPlanned.name}` : 'Nowhere to carry into'}
              </span>
              <span className="spacer" />
              <button className="btn" onClick={async () => {
                await repo.close(closing.id, null, unfinished.map((t) => t.id))
                setClosing(null); toast(`${closing.name} closed`)
              }}>Close and drop the rest</button>
              <button className="btn primary" disabled={!nextPlanned} onClick={async () => {
                await repo.close(closing.id, nextPlanned!.id, unfinished.map((t) => t.id))
                setClosing(null); toast(`${closing.name} closed, ${unfinished.length} carried over`)
              }}>Close and carry over</button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
