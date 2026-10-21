import { useLiveQuery } from 'dexie-react-hooks'
import { Fragment, useState } from 'react'
import { Avatar } from '../components/Avatar'
import { BlockerButtons, BlockerNote } from '../components/BlockerActions'
import { db } from '../db/schema'
import type { Chase, ID } from '../db/types'
import { setParam } from '../hooks/useRoute'
import { formatDate } from '../lib/dates'
import { blockedDays, blockers as repo, describeWaitingOn, groupWaitingOn } from '../repo'

function ago(ts: number) {
  const d = Math.floor((Date.now() - ts) / 86_400_000)
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`
}

export function Blockers({ teamId }: { teamId: string }) {
  const [tab, setTab] = useState<'open' | 'resolved'>('open')
  // The one blocker whose row has its note box open, if any.
  const [noting, setNoting] = useState<ID | null>(null)

  const rows = useLiveQuery(() => (tab === 'open' ? repo.listOpen() : repo.listResolved()), [tab], [])
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const people = useLiveQuery(() => db.people.toArray(), [], [])
  const statuses = useLiveQuery(() => db.statuses.toArray(), [], [])
  const chases = useLiveQuery(() => repo.allChases(), [], [])
  // Scoped to the team, like the rows below and the sidebar badge. Counting
  // every team's blockers here put a number above the list that the list itself
  // contradicted.
  const openCount = useLiveQuery(
    () => repo.openForTeam(teamId).then((r) => r.length),
    [teamId], 0,
  )

  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const personById = new Map(people.map((p) => [p.id, p]))
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  const chasesByBlocker = new Map<string, Chase[]>()
  for (const c of [...chases].sort((a, b) => a.at - b.at)) {
    const list = chasesByBlocker.get(c.blockerId) ?? []
    list.push(c)
    chasesByBlocker.set(c.blockerId, list)
  }

  const mine = rows
    .filter((b) => taskById.has(b.taskId))
    .sort((a, b) => a.openedAt - b.openedAt)

  const totalDays = mine.reduce((sum, b) => sum + blockedDays(b), 0)

  const describe = (b: (typeof mine)[number]) => describeWaitingOn(
    b,
    b.waitingOnPersonId ? personById.get(b.waitingOnPersonId)?.name : null,
    b.waitingOnTaskId ? taskById.get(b.waitingOnTaskId)?.key : null,
  )
  const waits = groupWaitingOn(mine, describe)
  // One group is just the total said twice; the split only says something when
  // there is something to compare it against.
  const worthSplitting = waits.length > 1 && totalDays > 0

  return (
    <>
      <div className="topbar">
        <h1>Blockers</h1>
        <button className={`chip btn-like${tab === 'open' ? ' on' : ''}`} onClick={() => setTab('open')}>Open {openCount}</button>
        <button className={`chip btn-like${tab === 'resolved' ? ' on' : ''}`} onClick={() => setTab('resolved')}>Resolved</button>
        <span className="spacer" />
        <span className="small faint">Oldest first</span>
      </div>

      <div className="screen pad">
        {mine.length === 0 ? (
          <div className="empty">
            <strong>{tab === 'open' ? 'Nothing is blocked' : 'Nothing resolved yet'}</strong>
            {tab === 'open'
              ? 'Mark a task as blocked from its detail panel and it will appear here with an age on it.'
              : 'Blockers you unblock are kept, so you can say at the retro how long things really took.'}
          </div>
        ) : (
          <>
            {worthSplitting && (
              <div className="panel" style={{ marginBottom: 12 }}>
                <p className="panel-title">
                  Where the days went
                  <span className="spacer" />
                  <span className="faint" style={{ fontWeight: 400 }}>
                    {totalDays} day{totalDays === 1 ? '' : 's'} across {waits.length} things
                  </span>
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {waits.slice(0, 6).map((w) => (
                    <div key={w.key} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{ width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {w.label}
                      </span>
                      <span className="bar" style={{ flex: 1 }}>
                        <i className={w.days >= waits[0].days ? 'hot' : ''}
                          style={{ width: `${(w.days / Math.max(1, waits[0].days)) * 100}%` }} />
                      </span>
                      <span className="small faint" style={{ width: 96, textAlign: 'right' }}>
                        {w.days}d · {w.count} task{w.count === 1 ? '' : 's'}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="small faint" style={{ marginTop: 10, marginBottom: 0, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
                  {waits[0].days > 0 && waits[0].days / Math.max(1, totalDays) >= 0.4
                    ? `${waits[0].days} of those ${totalDays} days went to ${waits[0].label} alone. That is one conversation, not a process problem.`
                    : 'Spread fairly evenly, so there is no single thing to go and fix.'}
                </p>
              </div>
            )}

            <div className="rows">
              <div className="row-head">
                <span style={{ width: 52 }}>Age</span>
                <span style={{ flex: 1 }}>Task</span>
                <span style={{ width: 168 }}>Waiting on</span>
                <span style={{ width: 116 }}>Chased</span>
                <span style={{ width: 176 }} />
              </div>
              {mine.map((b) => {
                const task = taskById.get(b.taskId)!
                const days = blockedDays(b)
                const owner = task.assigneeId ? personById.get(task.assigneeId) : null
                const list = chasesByBlocker.get(b.id) ?? []
                return (
                  <Fragment key={b.id}>
                    <div className="row">
                      <b style={{ width: 52, fontSize: 15, color: days >= 3 ? 'var(--alert)' : 'var(--ink)' }}>{days}d</b>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <button className="linkish" onClick={() => setParam('task', task.id)}>{task.title}</button>
                        <div className="small faint" style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 3 }}>
                          <Avatar person={owner} size={16} />
                          <span>{owner?.name ?? 'Nobody'}</span>
                          <span>·</span>
                          <span>{statusById.get(task.statusId)?.name}</span>
                          <span>·</span>
                          <span>{b.reason}</span>
                        </div>
                        {/* How it cleared is the other half of the retro story. */}
                        {b.resolvedAt !== null && (
                          <div className="small" style={{ marginTop: 3 }}>
                            <span className="faint">Resolved {formatDate(b.resolvedAt)}{b.resolutionNote ? ':' : ''}</span>
                            {b.resolutionNote && <span className="muted"> {b.resolutionNote}</span>}
                          </div>
                        )}
                      </div>
                      <span style={{ width: 168 }}>{describe(b)}</span>
                      <span style={{ width: 116 }} className={list.length ? '' : 'faint'}
                        title={list.map((c) => `${formatDate(c.at)}${c.note ? ` — ${c.note}` : ''}`).join('\n') || undefined}>
                        {list.length === 0 ? 'Never' : `${list.length}× · ${ago(list[list.length - 1].at)}`}
                      </span>
                      <div style={{ width: 176, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {tab === 'resolved' ? (
                          <button className="btn ghost sm" onClick={() => repo.reopen(b.id)}>Reopen</button>
                        ) : noting !== b.id && (
                          <BlockerButtons blockerId={b.id} onNote={() => setNoting(b.id)} />
                        )}
                      </div>
                    </div>
                    {/* Under its own row and lined up with the task, so there is no doubt which blocker it is for. */}
                    {tab === 'open' && noting === b.id && (
                      <div className="row" style={{ borderTop: 0, paddingTop: 0 }}>
                        <span style={{ width: 52, flex: 'none' }} />
                        <BlockerNote blockerId={b.id} onDone={() => setNoting(null)} />
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
            <p className="small faint" style={{ marginTop: 14, maxWidth: '62ch' }}>
              {tab === 'open'
                ? `${totalDays} blocked day${totalDays === 1 ? '' : 's'} across ${mine.length} task${mine.length === 1 ? '' : 's'} right now. At the retro this is a number rather than an impression.`
                : `${totalDays} day${totalDays === 1 ? '' : 's'} lost to blockers that have since cleared.`}
            </p>
          </>
        )}
      </div>
    </>
  )
}
