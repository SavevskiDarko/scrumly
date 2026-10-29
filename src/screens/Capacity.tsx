import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Availability, Person, Sprint, Task } from '../db/types'
import { go, setParam, useRoute } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import {
  availability as availRepo, capacity as capRepo, capacityPeopleIds, capacitySheet, settings as settingsRepo,
  sprints as sprintRepo, type CapacityLine, type CapacityRates, type CapacitySheet,
} from '../repo'
import { formatDate } from '../lib/dates'

type Saved = Promise<{ ok: boolean; reason?: string }>

// One argument only, as on Sprint planning: .map() would hand formatDate the index.
const fmt = (iso: string) => formatDate(iso)

/** 49.5, not 49.50. */
const h = (n: number) => String(Math.round(n * 100) / 100)

/** "3,5" is how half past three is typed in much of Europe, and in the spreadsheet this replaces. */
function parseHours(raw: string): number | null | 'bad' {
  const s = raw.trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : 'bad'
}

/** Enter and the arrow keys move up and down a column, as they do in a spreadsheet. */
function moveFocus(e: React.KeyboardEvent<HTMLInputElement>) {
  const down = e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)
  const up = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)
  if (!down && !up) return
  e.preventDefault()
  const el = e.currentTarget
  const row = Number(el.dataset.row) + (down ? 1 : -1)
  const next = document.querySelector<HTMLInputElement>(`.tc-in[data-col="${el.dataset.col}"][data-row="${row}"]`)
  el.blur()
  next?.focus()
}

/**
 * One number in the grid. Saved on blur, like every number in Scrumly: saving
 * as it is typed books 1 hour on the way to 16. Declared out here so React
 * does not remount it mid-edit.
 */
function HoursCell({ value, computed, row, col, title, onSave }: {
  value: number | null
  /** Shown faint when nothing is typed: what the sheet works out on its own. */
  computed?: number
  row: number
  col: string
  title?: string
  onSave: (hours: number | null) => Saved
}) {
  const toast = useToast()
  const shown = value == null ? '' : h(value)
  return (
    <input
      key={shown} className="tc-in" inputMode="decimal" data-row={row} data-col={col} title={title}
      defaultValue={shown} placeholder={computed != null ? h(computed) : ''}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.currentTarget.value = shown; e.currentTarget.blur(); return }
        moveFocus(e)
      }}
      onBlur={async (e) => {
        const input = e.currentTarget
        const next = parseHours(input.value)
        if (next === 'bad') { toast('Hours are a number, zero or more', true); input.value = shown; return }
        if (next === value) return
        const r = await onSave(next)
        if (!r.ok) { toast(r.reason ?? 'Could not save that', true); input.value = shown }
      }}
    />
  )
}

function RateInput({ label, value, unit, title, onSave }: {
  label: string; value: number; unit: string; title: string; onSave: (n: number) => Saved
}) {
  const toast = useToast()
  return (
    <label className="tc-rate" title={title}>
      {label}
      <input
        key={value} className="input" inputMode="decimal" defaultValue={h(value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        onBlur={async (e) => {
          const input = e.currentTarget
          const next = parseHours(input.value)
          if (next === value) return
          const r = next == null || next === 'bad' ? { ok: false, reason: 'That needs a number' } : await onSave(next)
          if (!r.ok) { toast(r.reason ?? 'Could not save that', true); input.value = h(value) }
        }}
      />
      {unit}
    </label>
  )
}

function verdict(view: CapacitySheet): { text: string; hot: boolean } {
  const { totals, lines } = view
  if (!lines.length) return { text: 'Nobody in this team yet, so there are no hours to plan with.', hot: false }
  const over = lines.filter((l) => l.left < 0)
  const overText = over.length
    ? ` Over: ${over.map((l) => `${l.person.name.split(' ')[0]} by ${h(-l.left)} h`).join(', ')}.`
    : ''
  if (totals.capacity <= 0) return { text: 'Nobody has hours for sprint work this sprint.', hot: false }
  if (totals.booked === 0) {
    return { text: `${h(totals.left)} h free and nothing booked yet. Add the work below and put hours against it.`, hot: false }
  }
  const room = [...lines].filter((l) => l.left > 0).sort((a, b) => b.left - a.left).slice(0, 3)
  const roomText = room.length
    ? ` Most room: ${room.map((l) => `${l.person.name.split(' ')[0]} ${h(l.left)} h`).join(', ')}.`
    : ''
  if (totals.left < 0) return { text: `Booked ${h(-totals.left)} h past what the team has.${overText}`, hot: true }
  return { text: `${h(totals.booked)} h booked, ${h(totals.left)} h still free to take on.${roomText}${overText}`, hot: over.length > 0 }
}

export function Capacity({ teamId }: { teamId: string }) {
  const toast = useToast()
  const route = useRoute()
  const [adding, setAdding] = useState('')

  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const sprintList = useLiveQuery(() => sprintRepo.listForTeam(teamId), [teamId])
  const members = useTeamPeople(teamId)
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [] as Task[])
  const statuses = useLiveQuery(() => db.statuses.toArray(), [], [])

  const list: Sprint[] = sprintList ?? []
  const wanted = route.params.get('sprint')
  // The running sprint is what this is usually open for; the next one is
  // where its numbers get worked out before it starts.
  const sprint = list.find((s) => s.id === wanted)
    ?? list.find((s) => s.state === 'active')
    ?? list.find((s) => s.state === 'planned')
    ?? list[list.length - 1]
    ?? null

  const read = useLiveQuery(
    () => (sprint ? capRepo.read(teamId, sprint.id) : Promise.resolve(null)),
    [teamId, sprint?.id],
  )
  const avail = useLiveQuery(
    () => (sprint ? availRepo.forSprint(sprint.id) : Promise.resolve([] as Availability[])),
    [sprint?.id], [] as Availability[],
  )
  const formerIds = capacityPeopleIds(read?.sheet ?? null).filter((id) => !members.some((m) => m.id === id))
  const former = useLiveQuery(
    async () => (formerIds.length ? (await db.people.bulkGet(formerIds)).filter((p): p is Person => !!p) : []),
    [formerIds.join(',')], [] as Person[],
  )

  const holidays = cfg?.holidays ?? []
  const view = sprint && read
    ? capacitySheet({ sprint, members, former, sheet: read.sheet, rates: read.rates, availability: avail, tasks, holidays })
    : null

  const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))
  const onSheet = new Set(view?.columns.map((c) => c.item.taskId) ?? [])
  const missing = sprint ? tasks.filter((t) => t.sprintId === sprint.id && !onSheet.has(t.id)).length : 0
  // The sprint's own work first, then the rest of what is open.
  const pickable = tasks
    .filter((t) => !onSheet.has(t.id) && (t.sprintId === sprint?.id || !doneIds.has(t.statusId)))
    .sort((a, b) => Number(b.sprintId === sprint?.id) - Number(a.sprintId === sprint?.id)
      || a.key.localeCompare(b.key, undefined, { numeric: true }))
    .slice(0, 400)

  async function add() {
    if (!sprint) return
    const r = await capRepo.addItem(sprint.id, adding)
    if (!r.ok) { toast(r.reason ?? 'Could not add that', true); return }
    setAdding('')
    if (r.item && !r.item.taskId) toast(`${r.item.label} added. It is not a task in this team, so it stays as typed`)
  }

  async function addSprintTasks() {
    if (!sprint) return
    const n = await capRepo.addSprintTasks(sprint.id)
    toast(n ? `${n} task${n === 1 ? '' : 's'} from ${sprint.name} added` : 'Every task in the sprint is on the sheet already')
  }

  function removeColumn(itemId: string, label: string, total: number) {
    if (!sprint) return
    if (total > 0 && !confirm(`Take ${label} off the sheet? Its ${h(total)} booked hours go with it.`)) return
    void capRepo.removeItem(sprint.id, itemId)
  }

  const setRate = (key: keyof CapacityRates) => (n: number) => capRepo.setRates(sprint!.id, { [key]: n })

  const sprintHolidays = sprint
    ? holidays.filter((d) => d >= sprint.startDate && d <= sprint.endDate && ![0, 6].includes(new Date(`${d}T12:00:00`).getDay()))
    : []

  const said = view ? verdict(view) : null
  const bookedPct = view && view.totals.capacity > 0 ? Math.min(100, (view.totals.booked / view.totals.capacity) * 100) : 0
  const byRoom = view ? [...view.lines].sort((a, b) => b.left - a.left) : []

  const cells = (l: CapacityLine, row: number) => {
    if (!sprint || !view) return null
    const pid = l.person.id
    return (
      <>
        <td className="tc-calc">{h(l.working)}</td>
        <td>
          <HoursCell value={l.unknown || null} row={row} col="unknown"
            title="Hours nobody can account for yet. They come off before Others and OH are worked out."
            onSave={(v) => capRepo.setHours(sprint.id, pid, 'unknown', v)} />
        </td>
        <td>
          <HoursCell value={l.vacation || null} row={row} col="vacation"
            title="Hours off, in half days. The same days Sprint planning reads, so either screen can change them."
            onSave={(v) => capRepo.setVacation(sprint.id, pid, v)} />
        </td>
        <td>
          <HoursCell value={l.othersTyped ? l.others : null} computed={l.others} row={row} col="others"
            title={`${h(view.rates.othersPerDay)} h for each day in. Type over it to change it; clear it to go back.`}
            onSave={(v) => capRepo.setHours(sprint.id, pid, 'others', v)} />
        </td>
        <td>
          <HoursCell value={l.overheadTyped ? l.overhead : null} computed={l.overhead} row={row} col="overhead"
            title={`${h(view.rates.overheadPerDay)} h for each day in. Type over it to change it; clear it to go back.`}
            onSave={(v) => capRepo.setHours(sprint.id, pid, 'overhead', v)} />
        </td>
        <td className="tc-sum">{h(l.capacity)}</td>
        <td className={`tc-sum tc-left${l.left < 0 ? ' over' : l.left === 0 ? ' none' : ''}`}>{h(l.left)}</td>
        {view.columns.map((c, i) => (
          <td key={c.item.id} className={i === 0 ? 'tc-first' : undefined}>
            <HoursCell value={c.item.hours[pid] ?? null} row={row} col={`item-${c.item.id}`}
              onSave={(v) => capRepo.book(sprint.id, c.item.id, pid, v)} />
          </td>
        ))}
      </>
    )
  }

  return (
    <>
      <div className="topbar">
        <h1>Team capacity</h1>
        {list.length > 0 && (
          <select className="select" style={{ width: 190 }} value={sprint?.id ?? ''}
            onChange={(e) => setParam('sprint', e.target.value || null)}>
            {[...list].reverse().map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.state === 'active' ? ' — running' : s.state === 'planned' ? ' — planned' : ''}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {sprint && missing > 0 && (
          <button className="btn" onClick={() => void addSprintTasks()}>
            Add the sprint's {missing} task{missing === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {sprintList === undefined ? null : !sprint ? (
          <div className="empty">
            <strong>No sprints yet</strong>
            Capacity is worked out per sprint. Plan one and its hours show here.
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => go('planning')}>Sprint planning</button>
            </div>
          </div>
        ) : !view || !said ? null : (
          <>
            <div className="plan-top">
              <div className="panel" style={{ flex: 1.4, minWidth: 300 }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <span className="label">{sprint.name}</span>
                    <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
                      {fmt(sprint.startDate)} – {fmt(sprint.endDate)}
                    </div>
                    <div className="small faint" style={{ marginTop: 4 }}>
                      {view.workingDays} working day{view.workingDays === 1 ? '' : 's'} · {h(view.workingDays * view.rates.hoursPerDay)} h each
                      {sprintHolidays.length > 0 && ` · ${sprintHolidays.length} holiday${sprintHolidays.length === 1 ? '' : 's'} taken out`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="kpi-n" style={{ color: view.totals.left < 0 ? 'var(--alert)' : undefined }}>
                      {h(view.totals.left)}
                      <span className="faint" style={{ fontSize: 14 }}> / {h(view.totals.capacity)} h</span>
                    </div>
                    <div className="small faint">free to take / total capacity</div>
                  </div>
                </div>
                <div className="bar" style={{ marginTop: 12 }} title={`${h(view.totals.booked)} h booked`}>
                  <i className={view.totals.left < 0 ? 'hot' : ''} style={{ width: `${bookedPct}%` }} />
                </div>
                <p className="small" style={{ margin: '8px 0 0', color: said.hot ? 'var(--alert)' : 'var(--muted)' }}>{said.text}</p>
                <div className="tc-rates small faint">
                  <RateInput label="Day" unit="h" value={view.rates.hoursPerDay} onSave={setRate('hoursPerDay')}
                    title="Hours in a working day" />
                  <RateInput label="Others" unit="h a day" value={view.rates.othersPerDay} onSave={setRate('othersPerDay')}
                    title="Hours of each day in that go to everything else: mail, admin, interruptions" />
                  <RateInput label="OH" unit="h a day" value={view.rates.overheadPerDay} onSave={setRate('overheadPerDay')}
                    title="Overhead: hours of each day in that go to stand-ups, refinement, reviews and other meetings" />
                </div>
              </div>

              <div className="panel" style={{ flex: 1, minWidth: 280 }}>
                <p className="panel-title">
                  Free to take
                  <span className="spacer" />
                  <span className="faint" style={{ fontWeight: 400 }}>{h(view.totals.booked)} h booked</span>
                </p>
                {byRoom.length === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>Nobody in this team yet. Add people and their hours show here.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {byRoom.map((l) => (
                      <div key={l.person.id} className="cap-row">
                        <Avatar person={l.person} size={20} dim={!l.member} />
                        <span className="cap-name" title={l.person.name}>{l.person.name.split(' ')[0]}</span>
                        <span className="bar" style={{ flex: 1 }} title={`${h(l.booked)} of ${h(l.capacity)} h booked`}>
                          <i className={l.left < 0 ? 'hot' : ''}
                            style={{ width: `${l.capacity > 0 ? Math.min(100, (l.booked / l.capacity) * 100) : l.booked > 0 ? 100 : 0}%` }} />
                        </span>
                        <span className="small" style={{
                          width: 64, textAlign: 'right', fontWeight: 600,
                          color: l.left < 0 ? 'var(--alert)' : l.left === 0 ? 'var(--faint)' : undefined,
                        }}>{h(l.left)} h</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title tc-head">
                Hours per person
                <span className="spacer" />
                <form className="tc-add" onSubmit={(e) => { e.preventDefault(); void add() }}>
                  <input className="input" list="tc-tasks" placeholder="Task key, or any other work"
                    value={adding} onChange={(e) => setAdding(e.target.value)} />
                  <datalist id="tc-tasks">
                    {pickable.map((t) => <option key={t.id} value={t.key}>{t.title}</option>)}
                  </datalist>
                  <button className="btn sm" disabled={!adding.trim()}>Add work</button>
                </form>
              </div>
              <div className="tc-scroll">
                <table className="tc-grid">
                  <thead>
                    <tr>
                      <th className="tc-who">Team member</th>
                      <th title="Every working day in the sprint, in hours">Working h</th>
                      <th title="Hours nobody can account for yet">Unknown</th>
                      <th title="Hours off. The same as the days in Sprint planning">Vacation</th>
                      <th title="Mail, admin, interruptions: worked out from the days in">Others</th>
                      <th title="Overhead: stand-ups, refinement, reviews, meetings. Worked out from the days in">OH</th>
                      <th className="tc-sum" title="Working h less unknown, vacation, others and OH">Total capacity</th>
                      <th className="tc-sum" title="Total capacity less every hour booked: what can still be taken on">Hours left</th>
                      {view.columns.map((c, i) => (
                        <th key={c.item.id} className={`tc-task${i === 0 ? ' tc-first' : ''}`}>
                          <div className="tc-task-head">
                            {c.task
                              ? <button className="linkish" title={c.task.title} onClick={() => setParam('task', c.task!.id)}>{c.task.key}</button>
                              : <span title={c.item.taskId ? 'This task has since been deleted' : 'Not a task in this team'}>{c.item.label}</span>}
                            <button className="chip-x" title="Take it off the sheet" aria-label={`Take ${c.item.label} off the sheet`}
                              onClick={() => removeColumn(c.item.id, c.item.label, c.total)}>×</button>
                          </div>
                          <div className="tc-task-title" title={c.task?.title}>
                            {c.task ? c.task.title : c.item.taskId ? 'deleted' : 'not a task here'}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {view.lines.map((l, row) => (
                      <tr key={l.person.id} className={l.member ? undefined : 'tc-former'}>
                        <td className="tc-who">
                          <button className="tc-person" onClick={() => setParam('member', l.person.id)}>
                            <Avatar person={l.person} size={18} dim={!l.member} />
                            <span>{l.person.name}</span>
                          </button>
                          {!l.member && <span className="small faint"> · not in the team now</span>}
                        </td>
                        {cells(l, row)}
                      </tr>
                    ))}
                  </tbody>
                  {view.lines.length > 0 && (
                    <tfoot>
                      <tr>
                        <td className="tc-who">Total</td>
                        <td>{h(view.totals.working)}</td>
                        <td>{view.totals.unknown ? h(view.totals.unknown) : ''}</td>
                        <td>{view.totals.vacation ? h(view.totals.vacation) : ''}</td>
                        <td>{h(view.totals.others)}</td>
                        <td>{h(view.totals.overhead)}</td>
                        <td className="tc-sum">{h(view.totals.capacity)}</td>
                        <td className={`tc-sum tc-left${view.totals.left < 0 ? ' over' : ''}`}>{h(view.totals.left)}</td>
                        {view.columns.map((c, i) => (
                          <td key={c.item.id} className={i === 0 ? 'tc-first' : undefined}>{c.total ? h(c.total) : ''}</td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {view.columns.length === 0 && (
                <p className="small faint" style={{ margin: '10px 0 0' }}>
                  No work on the sheet yet. {missing > 0 ? 'Add the sprint\'s tasks from the top bar, or type' : 'Type'} a
                  task key above to book hours against it. Work that is not a task here — another project's ticket,
                  support — can go on too, by name.
                </p>
              )}
              <p className="small faint" style={{ margin: '10px 0 0' }}>
                Vacation is the days off <button className="linkish" style={{ fontWeight: 500 }}
                  onClick={() => go('planning', { sprint: sprint.state === 'closed' ? null : sprint.id })}>Sprint planning</button> reads,
                in hours, so it goes in half days. Others and OH are worked out from the days someone is in; type over
                one to change it, clear it to go back. Enter and the arrow keys move up and down a column.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  )
}
