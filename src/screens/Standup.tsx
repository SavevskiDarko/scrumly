import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Person, StatusEvent, Task } from '../db/types'
import { go } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import {
  blockedDays, blockers as blockerRepo, buildIndex, daysInStatus, followUps as fuRepo,
  standups, tasks as taskRepo, type StandupSummary,
} from '../repo'

type Capture = 'blocker' | 'followup' | 'task'

function Elapsed({ from }: { from: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((Date.now() - from) / 1000)
  return <span className="chip solid" style={{ fontVariantNumeric: 'tabular-nums' }}>
    {String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}
  </span>
}

export function Standup({ teamId }: { teamId: string }) {
  const toast = useToast()
  const [index, setIndex] = useState(0)
  const [finished, setFinished] = useState<StandupSummary | null>(null)
  const [mode, setMode] = useState<Capture>('blocker')
  const [text, setText] = useState('')
  const [targetTaskId, setTargetTaskId] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const session = useLiveQuery(
    () => standups.latest(teamId).then((s) => (s && !s.endedAt ? s : null)),
    [teamId], undefined,
  )
  const allStandups = useLiveQuery(() => db.standups.where('teamId').equals(teamId).sortBy('startedAt'), [teamId], [])
  const people = useTeamPeople(teamId)
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])

  const ix = buildIndex(statuses, people, openBlockers)
  const order = session?.personOrder.filter((id) => people.some((p) => p.id === id)) ?? []
  const current: Person | undefined = people.find((p) => p.id === order[index])

  const previousStart = useMemo(() => {
    if (!session) return Date.now() - 86_400_000
    const earlier = allStandups.filter((s) => s.startedAt < session.startedAt)
    return earlier.length ? earlier[earlier.length - 1].startedAt : Date.now() - 86_400_000
  }, [session?.id, allStandups.length])

  const recent = useLiveQuery(
    () => (session ? db.statusEvents.where('at').between(previousStart, session.startedAt, true, true).toArray() : Promise.resolve([] as StatusEvent[])),
    [previousStart, session?.startedAt], [] as StatusEvent[],
  )

  const theirs = current
    ? tasks.filter((t) => {
        if (ix.doneIds.has(t.statusId)) return false
        return t.assigneeId === current.id || t.reviewerId === current.id || t.testerId === current.id
      })
    : []
  const theirActive = theirs.filter((t) => ix.activeIds.has(t.statusId))
  const movedSince = current
    ? recent.filter((e) => {
        const t = tasks.find((x) => x.id === e.taskId)
        return t && (t.assigneeId === current.id || t.reviewerId === current.id || t.testerId === current.id)
      })
    : []

  useEffect(() => { setTargetTaskId(theirActive[0]?.id ?? theirs[0]?.id ?? '') }, [current?.id, theirs.length])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      if (typing && e.key !== 'Escape') return
      if (e.key === 'ArrowRight') { e.preventDefault(); setIndex((i) => Math.min(i + 1, order.length - 1)) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Escape') { if (typing) (el as HTMLElement).blur(); else go('today') }
      if (e.key.toLowerCase() === 'b' && !typing) { e.preventDefault(); setMode('blocker'); inputRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order.length])

  if (session === undefined) return <div className="empty" style={{ marginTop: 70 }}>Loading…</div>

  if (finished) {
    return (
      <div className="standup-wrap">
        <div className="standup-card">
          <h2 style={{ marginTop: 0 }}>Stand-up done</h2>
          <p className="muted">{finished.minutes} minute{finished.minutes === 1 ? '' : 's'} for {order.length} people.</p>
          <div className="summary-grid">
            {[
              ['Tasks moved', finished.moved],
              ['Blockers raised', finished.blockersOpened],
              ['Blockers cleared', finished.blockersResolved],
              ['Chases logged', finished.chases],
              ['Tasks added', finished.tasksCreated],
              ['Follow-ups for you', finished.followUps],
            ].map(([label, n]) => (
              <div key={String(label)} className="summary-cell">
                <b>{n}</b><span>{label}</span>
              </div>
            ))}
          </div>
          <p className="small faint">
            All of it is already recorded. Nothing to write up afterwards.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => go('today')}>Back to Today</button>
            <button className="btn" onClick={() => go('blockers')}>See the blockers</button>
          </div>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="standup-wrap">
        <div className="standup-card">
          <h2 style={{ marginTop: 0 }}>Stand-up</h2>
          <p className="muted">
            One person at a time, their work already on screen, and anything you capture lands on the right task straight away.
            Arrow keys move between people.
          </p>
          <button className="btn primary" disabled={people.length === 0} onClick={async () => {
            await standups.start(teamId); setIndex(0); setFinished(null)
          }}>
            {people.length === 0 ? 'Nobody is in this team yet' : `Start with ${people.length} people`}
          </button>
        </div>
      </div>
    )
  }

  const nextStatusFor = (t: Task) => {
    const i = statuses.findIndex((s) => s.id === t.statusId)
    return i >= 0 && i < statuses.length - 1 ? statuses[i + 1] : null
  }

  async function capture() {
    if (!text.trim() || !current) return
    if (mode === 'blocker') {
      if (!targetTaskId) { toast('Pick which task is blocked', true); return }
      await blockerRepo.open(targetTaskId, { reason: text, waitingOnType: 'external', waitingOnText: null })
      toast('Blocker recorded')
    } else if (mode === 'followup') {
      await fuRepo.create({ title: text, personId: current.id })
      toast('Follow-up saved for you')
    } else {
      const col = statuses[1] ?? statuses[0]
      await taskRepo.create({ teamId, statusId: col.id, title: text, assigneeId: current.id })
      toast(`Task added for ${current.name.split(' ')[0]}`)
    }
    setText('')
  }

  const last = index === order.length - 1

  return (
    <>
      <div className="topbar">
        <span className="chip on">Stand-up</span>
        <span className="small faint">{order.length} people</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 6 }}>
          {order.map((id, i) => (
            <button key={id} onClick={() => setIndex(i)} title={people.find((p) => p.id === id)?.name}
              className={`pip${i < index ? ' done' : ''}${i === index ? ' now' : ''}`} />
          ))}
        </div>
        <span className="spacer" />
        <Elapsed from={session.startedAt} />
        <button className="btn ghost" onClick={async () => {
          if (!confirm('Abandon this stand-up? Nothing you already captured is lost.')) return
          await standups.cancel(session.id); go('today')
        }}>Abandon</button>
        <button className="btn" onClick={async () => {
          const s = await standups.summary(session)
          await standups.end(session.id)
          setFinished(s)
        }}>Finish</button>
      </div>

      <div className="screen pad">
        {!current ? (
          <div className="empty"><strong>Nobody to run through</strong>Add active people to this team.</div>
        ) : (
          <div style={{ maxWidth: 820 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              <Avatar person={current} size={52} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 21, fontWeight: 650, letterSpacing: '-.02em' }}>{current.name}</div>
                <div className="small faint">
                  {current.role} · {theirActive.length} active · {theirs.filter((t) => ix.blockerByTask.has(t.id)).length} blocked
                </div>
              </div>
              <span className="small faint">{index + 1} of {order.length}</span>
            </div>

            <div className="panel" style={{ marginBottom: 12 }}>
              <p className="panel-title">On now</p>
              {theirs.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing open. Worth asking what they picked up.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {theirs.map((t) => {
                  const b = ix.blockerByTask.get(t.id)
                  const next = nextStatusFor(t)
                  return (
                    <div key={t.id} className={`standup-task${b ? ' blocked' : ''}`}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 550 }}>{t.title}</div>
                        <div className="small faint">
                          {ix.byStatus.get(t.statusId)?.name} · {daysInStatus(t)}d
                          {b ? ` · blocked ${blockedDays(b)}d — ${b.reason}` : ''}
                        </div>
                      </div>
                      {b ? (
                        <>
                          <button className="btn sm" onClick={async () => { await blockerRepo.chase(b.id); toast('Chase logged') }}>Chase</button>
                          <button className="btn sm" onClick={async () => { await blockerRepo.resolve(b.id); toast('Unblocked') }}>Clear</button>
                        </>
                      ) : (
                        <button className="btn sm" onClick={() => { setMode('blocker'); setTargetTaskId(t.id); inputRef.current?.focus() }}>Block</button>
                      )}
                      {next && (
                        <button className="btn sm" onClick={() => taskRepo.move(t.id, next.id, null)}>→ {next.name}</button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="panel" style={{ flex: 1.4, minWidth: 300, borderColor: 'var(--accent)' }}>
                <p className="panel-title" style={{ color: 'var(--accent)' }}>Capture</p>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {([['blocker', 'Blocker'], ['followup', 'Follow-up for me'], ['task', 'New task']] as const).map(([v, l]) => (
                    <button key={v} className={`chip btn-like${mode === v ? ' on' : ''}`} onClick={() => setMode(v)}>{l}</button>
                  ))}
                </div>
                {mode === 'blocker' && theirs.length > 0 && (
                  <select className="select" style={{ marginBottom: 7 }} value={targetTaskId} onChange={(e) => setTargetTaskId(e.target.value)}>
                    {theirs.map((t) => <option key={t.id} value={t.id}>{t.key} — {t.title}</option>)}
                  </select>
                )}
                <input
                  ref={inputRef}
                  className="input"
                  value={text}
                  placeholder={mode === 'blocker' ? 'What is holding it up?' : mode === 'followup' ? 'Something for you to do' : 'What needs doing'}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void capture() }}
                />
                <div className="small faint" style={{ marginTop: 6 }}>Enter saves it and clears the box.</div>
              </div>

              <div className="panel" style={{ flex: 1, minWidth: 220 }}>
                <p className="panel-title">Since the last stand-up</p>
                {movedSince.length === 0 ? (
                  <p className="muted small" style={{ margin: 0 }}>Nothing of theirs moved. Worth a gentle question.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {movedSince.slice(0, 6).map((e) => (
                      <div key={e.id} className="small muted">
                        {tasks.find((t) => t.id === e.taskId)?.title ?? 'A task'}
                        <span className="faint"> → {ix.byStatus.get(e.toStatusId)?.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="standup-foot">
              <button className="btn" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
                ← {people.find((p) => p.id === order[index - 1])?.name.split(' ')[0] ?? 'Back'}
              </button>
              <span className="small faint">← → between people · B to capture a blocker · Esc to step out</span>
              {last ? (
                <button className="btn primary" onClick={async () => {
                  const s = await standups.summary(session)
                  await standups.end(session.id)
                  setFinished(s)
                }}>Finish</button>
              ) : (
                <button className="btn primary" onClick={() => setIndex((i) => i + 1)}>
                  {people.find((p) => p.id === order[index + 1])?.name.split(' ')[0]} →
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
