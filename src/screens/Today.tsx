import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { Avatar } from '../components/Avatar'
import { DateField } from '../components/DateField'
import { db } from '../db/schema'
import type { FollowUp, Person, StatusEvent, Task } from '../db/types'
import { go, setParam } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import { formatDate, formatDateWithWeekday, parseDateInput } from '../lib/dates'
import {
  blockedDays, blockers as blockerRepo, buildIndex, byDue, daysInStatus, describeWaitingOn,
  filterByBucket, followUpDue, followUps as fuRepo, loadByPerson, queues, settings as settingsRepo,
  sprints as sprintRepo, sprintStats, standups, todayISO, type BoardIndex, type Bucket, type FollowUpDue,
} from '../repo'

/**
 * Declared out here rather than inside Today: as a nested component React saw a
 * new type on every render and threw the whole list away each time.
 */
function AttnRow({ t, ix, note, chip, hot, onOpen }: {
  t: Task; ix: BoardIndex; note: string; chip?: string; hot?: boolean; onOpen: (id: string) => void
}) {
  const owner = t.assigneeId ? ix.byPerson.get(t.assigneeId) : null
  return (
    <button className={`attn${hot ? ' hot' : ''}`} onClick={() => onOpen(t.id)}>
      <Avatar person={owner} size={20} />
      <span className="attn-title">
        {t.title}
        <span className="faint"> · {note}</span>
      </span>
      <span className="chip">{ix.byStatus.get(t.statusId)?.name}</span>
      {chip && <span className="chip warn">{chip}</span>}
    </button>
  )
}

function Kpi({ n, label, hot, onClick, title }: {
  n: number; label: string; hot?: boolean; onClick: () => void; title?: string
}) {
  return (
    <button className={`kpi${hot && n > 0 ? ' hot' : ''}`} onClick={onClick} title={title} disabled={n === 0}>
      <span className="kpi-n">{n}</span>
      <span className="kpi-l">{label}</span>
    </button>
  )
}

/**
 * Every follow-up row carries the same edge, coloured only when it is late or
 * due today, so the marked ones stand out without the rest shifting sideways.
 */
const EDGE: React.CSSProperties = { borderLeft: '2px solid transparent', paddingLeft: 6, marginLeft: -8 }
const EDGE_COLOUR: Record<FollowUpDue, string> = {
  overdue: 'var(--alert)', today: 'var(--accent)', later: 'transparent', none: 'transparent',
}
// The accent's version of a warn chip: there, but not alarming.
const TODAY_CHIP: React.CSSProperties = { color: 'var(--accent)', borderColor: 'var(--accent)', background: 'var(--accent-soft)' }

/** Whole days from one ISO day to another, read at midday so a clock change cannot shave one off. */
function daysBetween(from: string, to: string) {
  return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000)
}

function dueLabel(dueDate: string, due: FollowUpDue, today: string) {
  if (due === 'overdue') return `${daysBetween(dueDate, today)}d overdue`
  if (due === 'today') return 'today'
  return daysBetween(today, dueDate) === 1 ? 'tomorrow' : formatDate(dueDate)
}

/**
 * The date field behind a follow-up's chip. It closes once a date is chosen or
 * you move on; a date it could not read keeps it open, marked, the way
 * DateField keeps it, rather than vanishing along with the box.
 */
function DueEditor({ f, onClose }: { f: FollowUp; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  // Opened by a click, so typing should start without another one.
  useEffect(() => { box.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])
  return (
    <div
      ref={box}
      style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 20 }}
      onBlur={(e) => {
        // Into the calendar button is not leaving.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        const typed = e.target instanceof HTMLInputElement && e.target.type !== 'date' ? e.target.value.trim() : ''
        if (typed && !parseDateInput(typed)) return
        onClose()
      }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <span className="small faint">Due</span>
      <DateField
        label="Due date" clearable value={f.dueDate} style={{ width: 150 }}
        onCommit={(iso) => {
          if (iso !== f.dueDate) void fuRepo.setDue(f.id, iso)
          if (iso) onClose()
        }}
      />
    </div>
  )
}

/** Out here for the same reason as AttnRow: each row keeps its own open date field. */
function FollowUpRow({ f, person, today }: { f: FollowUp; person: Person | null; today: string }) {
  const [editingDue, setEditingDue] = useState(false)
  const due = followUpDue(f, today)
  return (
    <div style={{ ...EDGE, borderLeftColor: EDGE_COLOUR[due], display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className={`followup${f.doneAt ? ' done' : ''}`}>
        <input
          type="checkbox"
          checked={Boolean(f.doneAt)}
          title={f.doneAt ? 'Put it back on the list' : 'Done'}
          onChange={() => (f.doneAt ? fuRepo.reopen(f.id) : fuRepo.complete(f.id))}
        />
        {/* Captured while somebody was still talking, so it has to be fixable. */}
        <input
          className="inline-input"
          style={{ flex: 1, minWidth: 0 }}
          key={`${f.id}-${f.title}`}
          defaultValue={f.title}
          onBlur={(e) => fuRepo.rename(f.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
        {!f.doneAt && !editingDue && (f.dueDate ? (
          <button
            className={`chip btn-like${due === 'overdue' ? ' warn' : ''}`}
            style={due === 'today' ? TODAY_CHIP : undefined}
            title={`Due ${formatDate(f.dueDate)}. Click to change it.`}
            onClick={() => setEditingDue(true)}
          >
            {dueLabel(f.dueDate, due, today)}
          </button>
        ) : (
          <button className="btn ghost sm" title="Give it a due date" onClick={() => setEditingDue(true)}>Due…</button>
        ))}
        {f.personId && <Avatar person={person} size={17} />}
        <button
          className="btn ghost sm" title="Delete this follow-up"
          onClick={() => { if (confirm(`Delete "${f.title}"?`)) void fuRepo.remove(f.id) }}
        >×</button>
      </div>
      {editingDue && <DueEditor f={f} onClose={() => setEditingDue(false)} />}
    </div>
  )
}

/** Typed straight into the list, so writing one down costs nothing but Enter. */
function AddFollowUp() {
  const [title, setTitle] = useState('')
  const add = async () => {
    if (!title.trim()) return
    await fuRepo.create({ title })
    setTitle('')
  }
  return (
    <div style={{ ...EDGE, display: 'flex', alignItems: 'center', gap: 7 }}>
      <span className="faint" style={{ width: 13, flex: 'none', textAlign: 'center', margin: '0 3px 0 4px' }}>+</span>
      <input
        className="inline-input"
        style={{ flex: 1, minWidth: 0, padding: '2px 4px', marginLeft: -4 }}
        placeholder="Add a follow-up"
        aria-label="Add a follow-up"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void add() }
          if (e.key === 'Escape') { setTitle(''); e.currentTarget.blur() }
        }}
      />
      {title.trim() && <button className="btn sm" onClick={() => void add()}>Add</button>}
    </div>
  )
}

export function Today({ teamId }: { teamId: string }) {
  const [followTab, setFollowTab] = useState<'open' | 'done'>('open')
  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useTeamPeople(teamId)
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])
  const chases = useLiveQuery(() => blockerRepo.allChases(), [], [])
  const openFollow = useLiveQuery(() => fuRepo.listOpen(), [], [] as FollowUp[])
  const doneFollow = useLiveQuery(
    () => (followTab === 'done' ? fuRepo.listDone() : Promise.resolve([] as FollowUp[])),
    [followTab], [] as FollowUp[],
  )
  // Open by when they are due, overdue first, then the undated ones oldest-first,
  // because the one that has waited longest is the one nagging you. Done
  // newest-first, because that is the one you just ticked.
  const follow = followTab === 'done'
    ? [...doneFollow].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    : [...openFollow].sort(byDue)
  const todayIso = todayISO()
  const running = useLiveQuery(() => standups.latest(teamId).then((s) => (s && !s.endedAt ? s : null)), [teamId], null)
  const sprint = useLiveQuery(async () => (await sprintRepo.active(teamId)) ?? null, [teamId], null)
  // Only the sprint's own tasks matter to the strip below. Reading the whole
  // event log for one progress bar gets slower every week the app is used.
  const sprintTaskIds = sprint ? tasks.filter((t) => t.sprintId === sprint.id).map((t) => t.id) : []
  const statusEvents = useLiveQuery<StatusEvent[], StatusEvent[]>(
    () => (sprintTaskIds.length
      ? db.statusEvents.where('taskId').anyOf(sprintTaskIds).toArray()
      : Promise.resolve([] as StatusEvent[])),
    [sprintTaskIds.join(',')], [],
  )
  // Sprint events stay unscoped: what left the sprint is exactly the part that
  // is no longer in that task list.
  const sprintEvents = useLiveQuery(() => db.sprintEvents.toArray(), [], [])

  const ix = buildIndex(statuses, people, openBlockers)
  const blocked = filterByBucket(tasks, ix, 'blocked').sort(
    (a, b) => (ix.blockerByTask.get(a.id)!.openedAt) - (ix.blockerByTask.get(b.id)!.openedAt),
  )
  const stuck = filterByBucket(tasks, ix, 'stuck')
    .filter((t) => !ix.blockerByTask.has(t.id))
    .sort((a, b) => a.statusChangedAt - b.statusChangedAt)
  const overdue = filterByBucket(tasks, ix, 'overdue')
  const unowned = filterByBucket(tasks, ix, 'unowned')

  const load = loadByPerson(tasks, people, ix)
  const busiest = Math.max(1, ...load.map((l) => l.active.length))
  const qs = queues(tasks, statuses, ix)
  const chaseCount = new Map<string, number>()
  for (const c of chases) chaseCount.set(c.blockerId, (chaseCount.get(c.blockerId) ?? 0) + 1)

  const today = formatDateWithWeekday(new Date())
  const openTask = (id: string) => setParam('task', id)
  // Everything on this screen counts every task, so the board it opens has to as well.
  const showBucket = (b: Bucket) => go('board', { filter: b, sprint: 'all' })
  // One per row listed below, so the number in the corner is the list's own.
  const needsYou = blocked.length + stuck.length + overdue.length + unowned.length
  const nothingWrong = needsYou === 0

  const attnRow = (t: Task, note: string, chip?: string, hot?: boolean) => (
    <AttnRow key={t.id} t={t} ix={ix} note={note} chip={chip} hot={hot} onOpen={openTask} />
  )

  return (
    <>
      <div className="topbar">
        <h1>Today</h1>
        <span className="small faint">{today}</span>
        <span className="spacer" />
        <span className="small faint">{tasks.length} tasks · {people.length} people</span>
        <button className="btn primary" onClick={() => go('standup')}>
          {running ? 'Resume stand-up' : 'Run stand-up'}
        </button>
      </div>

      <div className="screen pad">
        {sprint && (() => {
          const st = sprintStats(sprint, tasks, statusEvents, sprintEvents, statuses, { holidays: cfg?.holidays })
          const pct = st.total ? Math.round((st.done / st.total) * 100) : 0
          return (
            <button className="sprint-strip" onClick={() => go('sprints')}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <b>{sprint.name}</b>
                  <span className="small faint">{sprint.goal || 'No goal set'}</span>
                </div>
                <div className="bar" style={{ marginTop: 7 }}><i style={{ width: `${pct}%` }} /></div>
                <div className="small faint" style={{ marginTop: 5 }}>
                  Day {st.dayIndex} of {st.dayCount} · {st.done} of {st.total} done
                  {st.addedAfterStart > 0 ? ` · ${st.addedAfterStart} added after it started` : ''}
                </div>
              </div>
            </button>
          )
        })()}

        <div className="kpi-row">
          <Kpi n={blocked.length} label="Blocked" hot onClick={() => showBucket('blocked')} />
          <Kpi n={overdue.length} label="Overdue" onClick={() => showBucket('overdue')} />
          <Kpi n={unowned.length} label="No assignee" onClick={() => showBucket('unowned')}
            title="Excludes your first column — nobody owning a backlog item is normal" />
          <Kpi n={stuck.length} label="Sitting too long" onClick={() => showBucket('stuck')}
            title="Past the threshold you set per column in Settings" />
        </div>

        <div className="today-grid">
          <div className="today-col">
            <div className="panel">
              <p className="panel-title">
                Needs you
                <span className="spacer" />
                <span className="faint" style={{ fontWeight: 400 }}>
                  {needsYou} item{needsYou === 1 ? '' : 's'}
                </span>
              </p>

              {nothingWrong && (
                <p className="muted" style={{ margin: 0 }}>
                  Nothing is blocked, overdue, stuck or unowned. Genuinely nothing to do here — go to the board.
                </p>
              )}

              {blocked.length > 0 && (
                <>
                  <div className="attn-head" style={{ color: 'var(--alert)' }}>Blocked</div>
                  {blocked.map((t) => {
                    const b = ix.blockerByTask.get(t.id)!
                    const chased = chaseCount.get(b.id) ?? 0
                    const who = describeWaitingOn(
                      b,
                      b.waitingOnPersonId ? ix.byPerson.get(b.waitingOnPersonId)?.name : null,
                      b.waitingOnTaskId ? tasks.find((x) => x.id === b.waitingOnTaskId)?.key : null,
                    )
                    return (
                      attnRow(t, `waiting on ${who}${chased ? `, chased ${chased}×` : ', never chased'}`, `${blockedDays(b)}d`, true)
                    )
                  })}
                </>
              )}

              {stuck.length > 0 && (
                <>
                  <div className="attn-head">Sitting too long</div>
                  {stuck.map((t) => (
                    attnRow(t, `${daysInStatus(t)} days without moving`)
                  ))}
                </>
              )}

              {overdue.length > 0 && (
                <>
                  <div className="attn-head">Past their due date</div>
                  {overdue.map((t) => attnRow(t, `due ${formatDate(t.dueDate)}`, 'overdue'))}
                </>
              )}

              {unowned.length > 0 && (
                <>
                  <div className="attn-head">Nobody owns these</div>
                  {unowned.map((t) => attnRow(t, 'no assignee'))}
                </>
              )}
            </div>

            {qs.map((q) => (
              <div className="panel" key={q.status.id}>
                <p className="panel-title">Sitting in {q.status.name.toLowerCase()}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {q.entries.map((e, i) => (
                    <div key={e.person?.id ?? `none-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar person={e.person} size={20} />
                      <span style={{ flex: 1 }}>{e.person?.name ?? 'Nobody assigned'}</span>
                      <span className="small faint">{e.count} task{e.count === 1 ? '' : 's'}</span>
                      <span className="small faint">oldest {e.oldestDays}d</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="today-col narrow">
            <div className="panel">
              <p className="panel-title">Team load<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>active work</span></p>
              {load.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nobody on this team yet.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {load.map(({ person, active, blocked: nb }) => (
                  <button key={person.id} className="load-row" onClick={() => go('board', { person: person.id, sprint: 'all' })}>
                    <Avatar person={person} size={20} />
                    <span style={{ width: 62, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person.name.split(' ')[0]}</span>
                    <span className="bar" style={{ flex: 1 }}>
                      <i className={active.length >= busiest && busiest > 1 ? 'hot' : ''} style={{ width: `${(active.length / busiest) * 100}%` }} />
                    </span>
                    <span className="small faint" style={{ width: 34, textAlign: 'right' }}>
                      {active.length}{nb > 0 ? ` · ${nb}🚫`.replace('🚫', 'b') : ''}
                    </span>
                  </button>
                ))}
              </div>
              {load.length > 1 && (() => {
                const sorted = [...load].sort((a, b) => b.active.length - a.active.length)
                const top = sorted[0], bottom = sorted[sorted.length - 1]
                if (top.active.length - bottom.active.length < 2) return null
                return (
                  <p className="small faint" style={{ marginTop: 10, marginBottom: 0, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
                    {top.person.name.split(' ')[0]} is carrying {top.active.length}; {bottom.person.name.split(' ')[0]} has {bottom.active.length}.
                  </p>
                )
              })()}
            </div>

            <div className="panel">
              <p className="panel-title">
                Your follow-ups
                <span className="spacer" />
                <span className="seg sm">
                  <button className={followTab === 'open' ? 'on' : ''} onClick={() => setFollowTab('open')}>
                    Open {openFollow.length > 0 ? openFollow.length : ''}
                  </button>
                  <button className={followTab === 'done' ? 'on' : ''} onClick={() => setFollowTab('done')}>Done</button>
                </span>
              </p>
              {follow.length === 0 && (
                <p className="small faint" style={{ margin: followTab === 'open' ? '0 0 9px' : 0 }}>
                  {followTab === 'open'
                    ? 'Things for you rather than the team. Type one below, or capture them during stand-up, and they wait here.'
                    : 'Nothing ticked off yet. What you finish stays here rather than disappearing.'}
                </p>
              )}
              {(follow.length > 0 || followTab === 'open') && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {follow.map((f) => (
                    <FollowUpRow key={f.id} f={f} today={todayIso}
                      person={f.personId ? ix.byPerson.get(f.personId) ?? null : null} />
                  ))}
                  {followTab === 'open' && <AddFollowUp />}
                </div>
              )}
            </div>


          </div>
        </div>
      </div>
    </>
  )
}
