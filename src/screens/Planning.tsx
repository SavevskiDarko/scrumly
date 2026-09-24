import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { DepChip } from '../components/DepChip'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Availability, Sprint, Task } from '../db/types'
import { useDependencies, type DepInfo } from '../hooks/useDependencies'
import { go, setParam, useRoute } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import {
  availability as availRepo, blockers as blockerRepo, buildIndex, capacityPlan,
  settings as settingsRepo, sprints as sprintRepo, tasks as taskRepo, velocity, type BoardIndex,
} from '../repo'

function fmt(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const isWeekday = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`).getDay()
  return d !== 0 && d !== 6
}

/**
 * Declared out here for the same reason as Today's rows: nested inside the
 * screen, React sees a new component type on every render and remounts the
 * size inputs mid-edit.
 */
function PlanRow({ task, ix, dep, inSprint, onMove }: {
  task: Task; ix: BoardIndex; dep: DepInfo | null; inSprint: boolean; onMove: () => void
}) {
  const drag = useDraggable({ id: `plan:${task.id}` })
  const assignee = task.assigneeId ? ix.byPerson.get(task.assigneeId) ?? null : null
  const done = ix.doneIds.has(task.statusId)
  const blocked = ix.blockerByTask.has(task.id)
  const waiting = !done && dep != null && dep.open > 0
  return (
    <div ref={drag.setNodeRef} className={`plan-row${drag.isDragging ? ' dragging' : ''}${done ? ' done' : ''}`}>
      <span className="plan-handle" {...drag.listeners} {...drag.attributes} title="Drag between the backlog and the sprint">⠿</span>
      <span className={`prio ${task.priority}`} title={`Priority: ${task.priority}`} />
      {/* Chips go on a line of their own, so the title keeps the width it needs to be read. */}
      <div className="plan-main">
        <div className="plan-line">
          <span className="task-key">{task.key}</span>
          <button className="linkish plan-title" onClick={() => setParam('task', task.id)} title={task.title}>{task.title}</button>
        </div>
        {(inSprint || blocked || waiting) && (
          <div className="plan-chips">
            {inSprint && <span className="chip" style={{ padding: '0 7px' }}>{ix.byStatus.get(task.statusId)?.name}</span>}
            {blocked && <span className="chip warn" style={{ padding: '0 7px' }}>blocked</span>}
            {waiting && <DepChip info={dep} long />}
          </div>
        )}
      </div>
      <Avatar person={assignee} size={20} />
      {/* On blur, like the drawer: a live field turned "13" into a 1-point task on the way. */}
      <input
        className="input plan-size" type="number" min={0} step={1} placeholder="—" title="Size in points"
        key={`size-${task.id}-${task.size}`} defaultValue={task.size ?? ''}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        onBlur={(e) => {
          const raw = e.target.value.trim()
          const n = Number(raw)
          const next = raw && Number.isFinite(n) && n >= 0 ? n : null
          if (next !== task.size) void taskRepo.update(task.id, { size: next })
        }}
      />
      <button className="btn sm plan-move" onClick={onMove}>{inSprint ? 'Remove' : 'Add'}</button>
    </div>
  )
}

function Zone({ id, children, style }: { id: string; children: React.ReactNode; style?: React.CSSProperties }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return <div ref={setNodeRef} className={`panel plan-zone${isOver ? ' over' : ''}`} style={style}>{children}</div>
}

export function Planning({ teamId }: { teamId: string }) {
  const toast = useToast()
  const route = useRoute()
  const [q, setQ] = useState('')
  const [dragging, setDragging] = useState<Task | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const sprintList = useLiveQuery(() => sprintRepo.listForTeam(teamId), [teamId], [] as Sprint[])
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [] as Task[])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useTeamPeople(teamId)
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])
  const statusEvents = useLiveQuery(() => db.statusEvents.toArray(), [], [])
  const sprintIds = sprintList.map((s) => s.id)
  const avail = useLiveQuery(
    () => (sprintIds.length ? availRepo.forSprints(sprintIds) : Promise.resolve([] as Availability[])),
    [sprintIds.join(',')], [] as Availability[],
  )

  const ix = buildIndex(statuses, people, openBlockers)
  const depOf = useDependencies(tasks, ix.doneIds)

  const open = sprintList.filter((s) => s.state !== 'closed')
  const wanted = route.params.get('sprint')
  // The next planned sprint is what planning is usually for; the running one
  // is the fallback, for pulling work in mid-sprint.
  const sprint = open.find((s) => s.id === wanted)
    ?? open.find((s) => s.state === 'planned')
    ?? open.find((s) => s.state === 'active')
    ?? null

  const holidays = cfg?.holidays ?? []
  const closed = sprintList.filter((s) => s.state === 'closed')
  const plan = sprint
    ? capacityPlan({
      sprint,
      members: people,
      tasks,
      availability: avail,
      history: velocity(closed, tasks, statusEvents, statuses),
      sprints: sprintList,
      holidays,
    })
    : null

  const statusOrder = new Map(statuses.map((s) => [s.id, s.order]))
  const byBoard = (a: Task, b: Task) =>
    (statusOrder.get(a.statusId) ?? 0) - (statusOrder.get(b.statusId) ?? 0) || a.orderInColumn - b.orderInColumn
  const closedIds = new Set(closed.map((s) => s.id))
  const needle = q.trim().toLowerCase()

  // Unfinished work in no sprint, or left behind in one that has closed.
  const backlog = tasks
    .filter((t) => !ix.doneIds.has(t.statusId))
    .filter((t) => !t.sprintId || closedIds.has(t.sprintId))
    .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.key.toLowerCase().includes(needle)
      || t.tags.some((g) => g.toLowerCase().includes(needle)))
    .sort(byBoard)
  const inSprint = sprint ? tasks.filter((t) => t.sprintId === sprint.id).sort(byBoard) : []
  const elsewhere = tasks.filter((t) =>
    !ix.doneIds.has(t.statusId) && t.sprintId && t.sprintId !== sprint?.id && !closedIds.has(t.sprintId)).length

  async function planAnother() {
    const s = await sprintRepo.plan({
      teamId,
      lengthDays: cfg?.sprintLengthDays ?? 14,
      startWeekday: cfg?.sprintStartWeekday ?? 1,
    })
    toast(`${s.name} planned for ${s.startDate}`)
    setParam('sprint', s.id)
  }

  async function move(task: Task, into: boolean) {
    if (!sprint) return
    await taskRepo.setSprint(task.id, into ? sprint.id : null)
  }

  function onStart(e: DragStartEvent) {
    setDragging(tasks.find((t) => t.id === String(e.active.id).slice(5)) ?? null)
  }

  function onEnd(e: DragEndEvent) {
    setDragging(null)
    const task = tasks.find((t) => t.id === String(e.active.id).slice(5))
    if (!task || !sprint || !e.over) return
    const zone = String(e.over.id)
    if (zone === 'zone:sprint' && task.sprintId !== sprint.id) void move(task, true)
    if (zone === 'zone:backlog' && task.sprintId === sprint.id) void move(task, false)
  }

  const over = plan?.forecast != null && plan.plannedPoints > plan.forecast
  const capPct = plan && plan.fullPersonDays > 0 ? Math.round((plan.personDays / plan.fullPersonDays) * 100) : 100
  const sprintHolidays = sprint
    ? holidays.filter((d) => d >= sprint.startDate && d <= sprint.endDate && isWeekday(d))
    : []
  const maxPoints = Math.max(1, ...(plan?.rows.map((r) => r.points) ?? [0]))

  function verdict(): string {
    if (!plan) return ''
    if (plan.forecast == null) {
      return 'No closed sprints yet, so there is no track record to plan against. Close this one and the next plan has a number.'
    }
    const diff = plan.plannedPoints - plan.forecast
    if (diff > 0) {
      return `${diff} point${diff === 1 ? '' : 's'} over what this team has finished with ${capPct}% of its days available. `
        + 'Something comes out now, or it carries over later.'
    }
    if (diff === 0) return 'Right at what this team has finished before with these days available.'
    return `Room for about ${-diff} more point${diff === -1 ? '' : 's'} on the evidence of the last `
      + `${plan.basedOn} sprint${plan.basedOn === 1 ? '' : 's'}.`
  }

  return (
    <>
      <div className="topbar">
        <h1>Sprint planning</h1>
        {open.length > 0 && (
          <select className="select" style={{ width: 170 }} value={sprint?.id ?? ''}
            onChange={(e) => setParam('sprint', e.target.value || null)}>
            {open.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' — running' : ''}</option>)}
          </select>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => void planAnother()}>Plan another</button>
        {sprint?.state === 'planned' && (
          <button className="btn primary" onClick={async () => {
            const r = await sprintRepo.activate(sprint.id)
            if (!r.ok) toast(r.reason ?? 'Could not start it', true)
            else toast(`${sprint.name} started`)
          }}>Start {sprint.name}</button>
        )}
      </div>

      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!sprint || !plan ? (
          <div className="empty">
            <strong>Nothing to plan</strong>
            Every sprint is closed, or there are none yet. Plan the next one and pull work into it here.
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => void planAnother()}>Plan a sprint</button>
            </div>
          </div>
        ) : (
          <>
            <div className="plan-top">
              <div className="panel" style={{ flex: 1.4, minWidth: 300 }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <span className="label">{sprint.name} goal</span>
                    <input className="inline-input" style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}
                      key={`${sprint.id}-goal-${sprint.goal}`} defaultValue={sprint.goal}
                      placeholder="One sentence the team can recite on day six"
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      onBlur={(e) => { if (e.target.value !== sprint.goal) void sprintRepo.update(sprint.id, { goal: e.target.value }) }} />
                    <div className="small faint" style={{ marginTop: 8 }}>
                      {fmt(sprint.startDate)} – {fmt(sprint.endDate)} · {plan.workingDays} working day{plan.workingDays === 1 ? '' : 's'}
                      {sprintHolidays.length > 0 && ` · ${sprintHolidays.length} holiday${sprintHolidays.length === 1 ? '' : 's'} taken out`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="kpi-n" style={{ color: over ? 'var(--alert)' : undefined }}>
                      {plan.plannedPoints}
                      <span className="faint" style={{ fontSize: 14 }}>/{plan.forecast ?? '—'}</span>
                    </div>
                    <div className="small faint">planned / forecast points</div>
                  </div>
                </div>
                <div className="bar" style={{ marginTop: 12 }}>
                  <i className={over ? 'hot' : ''} style={{
                    width: `${plan.forecast ? Math.min(100, (plan.plannedPoints / plan.forecast) * 100) : 0}%`,
                  }} />
                </div>
                <p className="small" style={{ margin: '8px 0 0', color: over ? 'var(--alert)' : 'var(--muted)' }}>{verdict()}</p>
                {plan.averageVelocity != null && (
                  <p className="small faint" style={{ margin: '4px 0 0' }}>
                    Averaging {plan.averageVelocity} point{plan.averageVelocity === 1 ? '' : 's'} over the
                    last {plan.basedOn} sprint{plan.basedOn === 1 ? '' : 's'}; this one has {capPct}% of the team's days.
                  </p>
                )}
                {plan.unsized > 0 && (
                  <p className="small faint" style={{ margin: '4px 0 0' }}>
                    {plan.unsized} task{plan.unsized === 1 ? ' has' : 's have'} no size and count{plan.unsized === 1 ? 's' : ''} as
                    one point each. Size them below and the numbers firm up.
                  </p>
                )}
              </div>

              <div className="panel" style={{ flex: 1, minWidth: 280 }}>
                <p className="panel-title">
                  Capacity
                  <span className="spacer" />
                  <span className="faint" style={{ fontWeight: 400 }}>{plan.personDays} of {plan.fullPersonDays} person-days</span>
                </p>
                {plan.rows.length === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>Nobody in this team yet, so there is no capacity to plan against.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {plan.rows.map((r) => {
                      const scale = r.share ?? maxPoints
                      const heavy = r.share != null && r.points > r.share + 0.5
                      return (
                        <div key={r.person.id} className="cap-row">
                          <Avatar person={r.person} size={20} />
                          <span className="cap-name" title={r.person.name}>{r.person.name.split(' ')[0]}</span>
                          <input
                            className="input cap-days" type="number" min={0} max={plan.workingDays} step={0.5}
                            key={`${sprint.id}-${r.person.id}-${r.entered ? r.days : 'full'}`}
                            defaultValue={r.entered ? r.days : ''} placeholder={String(plan.workingDays)}
                            title="Days available this sprint. Blank means every working day."
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                            onBlur={(e) => {
                              const raw = e.target.value.trim()
                              void availRepo.set(r.person.id, sprint.id, raw === '' ? null : Number(raw))
                            }}
                          />
                          <span className="small faint">d</span>
                          <span className="bar" style={{ flex: 1 }}>
                            <i className={heavy ? 'hot' : ''} style={{ width: `${scale > 0 ? Math.min(100, (r.points / scale) * 100) : 0}%` }} />
                          </span>
                          <span className="small faint" style={{ width: 70, textAlign: 'right' }}
                            title={r.share != null ? 'Points assigned to them, against their share of the forecast' : 'Points assigned to them'}>
                            {r.points}p{r.share != null ? ` of ~${Math.round(r.share)}` : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
                {(plan.unassignedPoints > 0 || plan.elsewherePoints > 0 || sprintHolidays.length > 0) && (
                  <div className="small faint" style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {plan.unassignedPoints > 0 && <span>{plan.unassignedPoints} point{plan.unassignedPoints === 1 ? '' : 's'} nobody is holding yet.</span>}
                    {plan.elsewherePoints > 0 && <span>{plan.elsewherePoints} point{plan.elsewherePoints === 1 ? '' : 's'} held by people no longer in this team.</span>}
                    {sprintHolidays.length > 0 && (
                      <span>
                        Off for everyone: {sprintHolidays.map(fmt).join(', ')}.{' '}
                        <button className="linkish" style={{ fontWeight: 500 }} onClick={() => go('settings')}>Holidays</button>
                      </span>
                    )}
                  </div>
                )}
                <p className="small faint" style={{ margin: '10px 0 0' }}>
                  Blank means every working day. Enter fewer for leave, training or support rota.
                </p>
              </div>
            </div>

            <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
              <div className="plan-cols">
                <Zone id="zone:backlog">
                  <p className="panel-title">
                    Backlog
                    <span className="spacer" />
                    <span className="faint" style={{ fontWeight: 400 }}>{backlog.length} unplanned</span>
                  </p>
                  <input className="input" style={{ marginBottom: 8 }} placeholder="Filter by title, key or #tag"
                    value={q} onChange={(e) => setQ(e.target.value)} />
                  {backlog.length === 0 && (
                    <p className="small faint" style={{ margin: '4px 0' }}>
                      {needle ? 'Nothing matches that.' : 'Nothing unplanned. Everything open is in a sprint already.'}
                    </p>
                  )}
                  {statuses.filter((s) => !s.isDone).map((s) => {
                    const items = backlog.filter((t) => t.statusId === s.id)
                    if (!items.length) return null
                    return (
                      <div key={s.id}>
                        <div className="attn-head">{s.name} <span style={{ fontWeight: 400 }}>{items.length}</span></div>
                        <div className="plan-list">
                          {items.map((t) => (
                            <PlanRow key={t.id} task={t} ix={ix} dep={depOf(t, sprint.id)} inSprint={false}
                              onMove={() => void move(t, true)} />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {elsewhere > 0 && (
                    <p className="small faint" style={{ margin: '10px 0 0' }}>
                      {elsewhere} more {elsewhere === 1 ? 'is' : 'are'} already planned into other sprints.
                    </p>
                  )}
                </Zone>

                <Zone id="zone:sprint" style={{ borderColor: 'var(--accent)' }}>
                  <p className="panel-title" style={{ color: 'var(--accent)' }}>
                    In {sprint.name}
                    <span className="spacer" />
                    <span className="faint" style={{ fontWeight: 400 }}>
                      {plan.plannedTasks} task{plan.plannedTasks === 1 ? '' : 's'} · {plan.plannedPoints} points
                    </span>
                  </p>
                  {inSprint.length === 0 ? (
                    <p className="small faint" style={{ margin: '4px 0' }}>
                      Nothing in it yet. Drag work across from the backlog, or use Add. Every join is logged, so the burndown
                      can tell what was committed up front from what arrived later.
                    </p>
                  ) : (
                    <div className="plan-list">
                      {inSprint.map((t) => (
                        <PlanRow key={t.id} task={t} ix={ix} dep={depOf(t, sprint.id)} inSprint
                          onMove={() => void move(t, false)} />
                      ))}
                    </div>
                  )}
                </Zone>
              </div>
              <DragOverlay dropAnimation={null}>
                {dragging && (
                  <div className="plan-row drag-ghost" style={{ width: 360 }}>
                    <span className="task-key">{dragging.key}</span>
                    <span className="plan-title">{dragging.title}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </>
        )}
      </div>
    </>
  )
}
