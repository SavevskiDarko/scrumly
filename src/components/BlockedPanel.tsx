import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db } from '../db/schema'
import type { Blocker, Chase, ID } from '../db/types'
import { useTeamPeople } from '../hooks/useTeamPeople'
import { blockedDays, blockers as repo, describeWaitingOn } from '../repo'
import { useToast } from './Toast'

const KINDS: { value: Blocker['waitingOnType']; label: string }[] = [
  { value: 'person', label: 'Someone on the team' },
  { value: 'task', label: 'Another task' },
  { value: 'team', label: 'Another team' },
  { value: 'external', label: 'Something outside' },
]

function ago(ts: number) {
  const d = Math.floor((Date.now() - ts) / 86_400_000)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

export function BlockedPanel({ taskId, teamId }: { taskId: ID; teamId: string }) {
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [reason, setReason] = useState('')
  const [kind, setKind] = useState<Blocker['waitingOnType']>('person')
  const [personId, setPersonId] = useState('')
  const [otherTaskId, setOtherTaskId] = useState('')
  const [text, setText] = useState('')

  const blocker = useLiveQuery(() => repo.openForTask(taskId), [taskId])
  const chases = useLiveQuery(() => (blocker ? repo.chasesFor(blocker.id) : Promise.resolve([] as Chase[])), [blocker?.id], [] as Chase[])
  const people = useTeamPeople(teamId)
  const otherTasks = useLiveQuery(
    () => db.tasks.where('teamId').equals(teamId).filter((t) => t.id !== taskId).toArray(),
    [teamId, taskId], [],
  )

  if (blocker) {
    const waitingOn = describeWaitingOn(
      blocker,
      blocker.waitingOnPersonId ? people.find((p) => p.id === blocker.waitingOnPersonId)?.name : null,
      blocker.waitingOnTaskId ? otherTasks.find((t) => t.id === blocker.waitingOnTaskId)?.key : null,
    )
    const days = blockedDays(blocker)
    return (
      <div className="blocked-box">
        <div className="blocked-head">
          <span className="prio urgent" />
          <b>Blocked {days === 0 ? 'since today' : `for ${days} day${days === 1 ? '' : 's'}`}</b>
          <span className="spacer" />
          <button className="btn sm" onClick={async () => { await repo.chase(blocker.id); toast('Chase logged') }}>
            Chase
          </button>
          <button className="btn sm" onClick={async () => { await repo.resolve(blocker.id); toast('Unblocked') }}>
            Unblock
          </button>
        </div>
        <div className="meta-grid" style={{ marginTop: 10, gridTemplateColumns: '84px 1fr' }}>
          <span className="label">Waiting on</span>
          <span>{waitingOn}</span>
          <span className="label">Reason</span>
          <input
            className="inline-input"
            defaultValue={blocker.reason}
            key={blocker.id}
            onBlur={(e) => e.target.value.trim() !== blocker.reason && repo.update(blocker.id, { reason: e.target.value.trim() })}
          />
          <span className="label">Chased</span>
          <span className={chases.length ? '' : 'faint'}>
            {chases.length === 0
              ? 'Not yet'
              : `${chases.length} time${chases.length === 1 ? '' : 's'}, last ${ago(chases[chases.length - 1].at)}`}
          </span>
        </div>
      </div>
    )
  }

  if (!adding) {
    return <button className="btn" onClick={() => setAdding(true)}>Mark as blocked</button>
  }

  return (
    <div className="blocked-box">
      <b style={{ fontSize: 12 }}>What is holding this up?</b>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 10 }}>
        <input className="input" autoFocus placeholder="Sandbox will not replay failed webhooks"
          value={reason} onChange={(e) => setReason(e.target.value)} />
        <div style={{ display: 'flex', gap: 8 }}>
          <select className="select" style={{ width: 176 }} value={kind}
            onChange={(e) => setKind(e.target.value as Blocker['waitingOnType'])}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          {kind === 'person' && (
            <select className="select" value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">Who?</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {kind === 'task' && (
            <select className="select" value={otherTaskId} onChange={(e) => setOtherTaskId(e.target.value)}>
              <option value="">Which task?</option>
              {otherTasks.map((t) => <option key={t.id} value={t.id}>{t.key} — {t.title}</option>)}
            </select>
          )}
          {(kind === 'team' || kind === 'external') && (
            <input className="input" placeholder={kind === 'team' ? 'Which team' : 'Vendor, ticket number, whatever'}
              value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!reason.trim()} onClick={async () => {
            await repo.open(taskId, {
              reason,
              waitingOnType: kind,
              waitingOnPersonId: kind === 'person' ? personId || null : null,
              waitingOnTaskId: kind === 'task' ? otherTaskId || null : null,
              waitingOnText: kind === 'team' || kind === 'external' ? text : null,
            })
            setAdding(false); setReason(''); setText(''); setPersonId(''); setOtherTaskId('')
          }}>Save</button>
          <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
        </div>
        <span className="small faint">
          The task stays in the column it is really in. Blocked is a flag, not a place to put things.
        </span>
      </div>
    </div>
  )
}
