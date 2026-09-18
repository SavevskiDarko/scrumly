import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { db } from '../db/schema'
import type { StatusEvent, Task } from '../db/types'
import { go, setParam } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import {
  blockedDays, blockers as blockerRepo, buildIndex, daysInStatus, describeWaitingOn,
  filterByBucket, followUps as fuRepo, loadByPerson, queues, sprints as sprintRepo,
  sprintStats, standups, type BoardIndex, type Bucket,
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

export function Today({ teamId }: { teamId: string }) {
  const [followTab, setFollowTab] = useState<'open' | 'done'>('open')
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useTeamPeople(teamId)
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])
  const chases = useLiveQuery(() => blockerRepo.allChases(), [], [])
  // Open oldest-first, because the one that has waited longest is the one
  // nagging you. Done newest-first, because that is the one you just ticked.
  const follow = useLiveQuery(
    () => (followTab === 'done'
      ? fuRepo.listDone().then((r) => r.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)))
      : fuRepo.listOpen().then((r) => r.sort((a, b) => a.createdAt - b.createdAt))),
    [followTab], [],
  )
  const openFollowCount = useLiveQuery(() => fuRepo.listOpen().then((r) => r.length), [], 0)
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

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const openTask = (id: string) => setParam('task', id)
  const showBucket = (b: Bucket) => go('board', { filter: b })
  const nothingWrong = blocked.length + stuck.length + overdue.length + unowned.length === 0

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
          const st = sprintStats(sprint, tasks, statusEvents, sprintEvents, statuses)
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
                  {blocked.length + stuck.length + unowned.length} item{blocked.length + stuck.length + unowned.length === 1 ? '' : 's'}
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
                  {overdue.map((t) => attnRow(t, `due ${t.dueDate}`, 'overdue'))}
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
                  <button key={person.id} className="load-row" onClick={() => go('board', { person: person.id })}>
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
                    Open {openFollowCount > 0 ? openFollowCount : ''}
                  </button>
                  <button className={followTab === 'done' ? 'on' : ''} onClick={() => setFollowTab('done')}>Done</button>
                </span>
              </p>
              {follow.length === 0 ? (
                <p className="small faint" style={{ margin: 0 }}>
                  {followTab === 'open'
                    ? 'Things for you rather than the team. Capture them during stand-up and they wait here.'
                    : 'Nothing ticked off yet. What you finish stays here rather than disappearing.'}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {follow.map((f) => (
                    <div key={f.id} className={`followup${f.doneAt ? ' done' : ''}`}>
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
                      {f.personId && <Avatar person={ix.byPerson.get(f.personId) ?? null} size={17} />}
                      <button
                        className="btn ghost sm" title="Delete this follow-up"
                        onClick={() => { if (confirm(`Delete "${f.title}"?`)) void fuRepo.remove(f.id) }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>


          </div>
        </div>
      </div>
    </>
  )
}
