import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db } from '../db/schema'
import type { Blocker, Chase, ID, Person, Task } from '../db/types'
import { usePickablePeople } from '../hooks/useTeamPeople'
import { formatDate } from '../lib/dates'
import { blockedDays, blockers as repo, describeWaitingOn } from '../repo'
import { BlockerButtons, BlockerNote } from './BlockerActions'

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

/** What a blocker waits on, as the pickers hold it until it is saved. */
interface WaitDraft { kind: Blocker['waitingOnType']; personId: ID; taskId: ID; text: string }

const NO_WAIT: WaitDraft = { kind: 'person', personId: '', taskId: '', text: '' }

const draftOf = (b: Blocker): WaitDraft => ({
  kind: b.waitingOnType,
  personId: b.waitingOnPersonId ?? '',
  taskId: b.waitingOnTaskId ?? '',
  text: b.waitingOnText ?? '',
})

/** Only the field that belongs to the kind is kept, so changing kind never leaves the old one behind. */
function waitingOnOf(d: WaitDraft) {
  return {
    waitingOnType: d.kind,
    waitingOnPersonId: d.kind === 'person' ? d.personId || null : null,
    waitingOnTaskId: d.kind === 'task' ? d.taskId || null : null,
    waitingOnText: d.kind === 'team' || d.kind === 'external' ? d.text.trim() || null : null,
  }
}

/**
 * The same pickers for a new blocker and for changing an open one. Declared out
 * here, like Today's rows, so React keeps it rather than rebuilding it per render.
 */
function WaitingOnFields({ draft, onChange, people, tasks }: {
  draft: WaitDraft; onChange: (d: WaitDraft) => void; people: Person[]; tasks: Task[]
}) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <select className="select" style={{ width: 176 }} value={draft.kind}
        onChange={(e) => onChange({ ...draft, kind: e.target.value as Blocker['waitingOnType'] })}>
        {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
      </select>
      {draft.kind === 'person' && (
        <select className="select" value={draft.personId} onChange={(e) => onChange({ ...draft, personId: e.target.value })}>
          <option value="">Who?</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {draft.kind === 'task' && (
        <select className="select" value={draft.taskId} onChange={(e) => onChange({ ...draft, taskId: e.target.value })}>
          <option value="">Which task?</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.key} — {t.title}</option>)}
        </select>
      )}
      {(draft.kind === 'team' || draft.kind === 'external') && (
        <input className="input" placeholder={draft.kind === 'team' ? 'Which team' : 'Vendor, ticket number, whatever'}
          value={draft.text} onChange={(e) => onChange({ ...draft, text: e.target.value })} />
      )}
    </div>
  )
}

export function BlockedPanel({ taskId, teamId }: { taskId: ID; teamId: string }) {
  const [adding, setAdding] = useState(false)
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<WaitDraft>(NO_WAIT)
  // Held against the blocker's id rather than as a flag, so a blocker raised
  // later never opens with the last one's note box or pickers already showing.
  const [notingFor, setNotingFor] = useState<ID | null>(null)
  const [changingFor, setChangingFor] = useState<ID | null>(null)

  const blocker = useLiveQuery(() => repo.openForTask(taskId), [taskId])
  const chases = useLiveQuery(() => (blocker ? repo.chasesFor(blocker.id) : Promise.resolve([] as Chase[])), [blocker?.id], [] as Chase[])
  // Whoever it waits on stays pickable, and named, after they leave the team.
  const people = usePickablePeople(teamId, [blocker?.waitingOnPersonId ?? null])
  const waitTaskId = blocker?.waitingOnTaskId ?? null
  const otherTasks = useLiveQuery(
    async () => {
      const own = await db.tasks.where('teamId').equals(teamId).filter((t) => t.id !== taskId).toArray()
      // The assistant can point a blocker at another team's task, and that one
      // has to be in the list too or changing the blocker would show it as unset.
      if (waitTaskId && !own.some((t) => t.id === waitTaskId)) {
        const other = await db.tasks.get(waitTaskId)
        if (other) own.push(other)
      }
      return own
    },
    [teamId, taskId, waitTaskId], [],
  )

  if (blocker) {
    const waitingOn = describeWaitingOn(
      blocker,
      blocker.waitingOnPersonId ? people.find((p) => p.id === blocker.waitingOnPersonId)?.name : null,
      blocker.waitingOnTaskId ? otherTasks.find((t) => t.id === blocker.waitingOnTaskId)?.key : null,
    )
    const days = blockedDays(blocker)
    const noting = notingFor === blocker.id
    const changing = changingFor === blocker.id
    return (
      <div className="blocked-box">
        <div className="blocked-head">
          <span className="prio urgent" />
          <b>Blocked {days === 0 ? 'since today' : `for ${days} day${days === 1 ? '' : 's'}`}</b>
          <span className="spacer" />
          {!noting && <BlockerButtons blockerId={blocker.id} onNote={() => setNotingFor(blocker.id)} />}
        </div>
        {noting && (
          <div style={{ display: 'flex', marginTop: 10 }}>
            <BlockerNote blockerId={blocker.id} onDone={() => setNotingFor(null)} />
          </div>
        )}
        <div className="meta-grid" style={{ marginTop: 10, gridTemplateColumns: '84px 1fr' }}>
          <span className="label" style={changing ? { alignSelf: 'start', paddingTop: 8 } : undefined}>Waiting on</span>
          {changing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <WaitingOnFields draft={draft} onChange={setDraft} people={people} tasks={otherTasks} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn primary sm" onClick={async () => {
                  const next = waitingOnOf(draft)
                  if ((Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== blocker[k])) {
                    await repo.update(blocker.id, next)
                  }
                  setChangingFor(null)
                }}>Save</button>
                <button className="btn ghost sm" onClick={() => setChangingFor(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{waitingOn}</span>
              <button className="btn ghost sm" title="Change who or what this is waiting on"
                onClick={() => { setDraft(draftOf(blocker)); setChangingFor(blocker.id) }}>Change</button>
            </span>
          )}
          <span className="label">Reason</span>
          <input
            className="inline-input"
            defaultValue={blocker.reason}
            key={blocker.id}
            onBlur={(e) => e.target.value.trim() !== blocker.reason && repo.update(blocker.id, { reason: e.target.value.trim() })}
          />
          <span className="label" style={chases.length ? { alignSelf: 'start', paddingTop: 2 } : undefined}>Chased</span>
          <div style={{ minWidth: 0 }}>
            <span className={chases.length ? '' : 'faint'}>
              {chases.length === 0
                ? 'Not yet'
                : `${chases.length} time${chases.length === 1 ? '' : 's'}, last ${ago(chases[chases.length - 1].at)}`}
            </span>
            {/* The log is what gets escalated: when each chase was, and what it was. */}
            {chases.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {chases.map((c) => (
                  <div key={c.id} className="small" style={{ display: 'flex', gap: 8 }}>
                    <span className="faint" style={{ width: 72, flex: 'none' }}>{formatDate(c.at)}</span>
                    <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{c.note}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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
        <WaitingOnFields draft={draft} onChange={setDraft} people={people} tasks={otherTasks} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!reason.trim()} onClick={async () => {
            await repo.open(taskId, { reason, ...waitingOnOf(draft) })
            setAdding(false); setReason(''); setDraft(NO_WAIT)
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
