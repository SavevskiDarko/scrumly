import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { db } from '../db/schema'
import type { ID, Sprint, Status, Task, Team } from '../db/types'
import { setParam } from '../hooks/useRoute'
import { DEPENDENCY_HINT, DEPENDENCY_LABEL, dependencyState, links as repo, type DependencyState } from '../repo'
import { useToast } from './Toast'

type Side = 'waitsOn' | 'holdsUp'

function StateChip({ state }: { state: DependencyState }) {
  const cls = state === 'late' || state === 'unscheduled' ? ' warn' : state === 'done' ? ' solid' : ''
  return <span className={`chip${cls}`} title={DEPENDENCY_HINT[state]}>{DEPENDENCY_LABEL[state]}</span>
}

export function DependencyPanel({ task }: { task: Task }) {
  const toast = useToast()
  const [adding, setAdding] = useState<Side | null>(null)
  const [q, setQ] = useState('')

  const rel = useLiveQuery(() => repo.forTask(task.id), [task.id], { waitsOn: [], holdsUp: [] })
  const otherIds = [...rel.waitsOn.map((l) => l.fromTaskId), ...rel.holdsUp.map((l) => l.toTaskId)].sort()
  const others = useLiveQuery(
    async () => (otherIds.length ? (await db.tasks.bulkGet(otherIds)).filter((t): t is Task => Boolean(t)) : []),
    [otherIds.join(',')], [] as Task[],
  )
  const statuses = useLiveQuery(() => db.statuses.toArray(), [], [] as Status[])
  const teams = useLiveQuery(() => db.teams.toArray(), [], [] as Team[])
  const sprints = useLiveQuery(() => db.sprints.toArray(), [], [] as Sprint[])
  // Only read everything while someone is actually searching for a task to link.
  const candidates = useLiveQuery(
    () => (adding ? db.tasks.toArray() : Promise.resolve([] as Task[])),
    [adding], [] as Task[],
  )

  const byId = new Map(others.map((t) => [t.id, t]))
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  const teamById = new Map(teams.map((t) => [t.id, t]))
  const sprintById = new Map(sprints.map((s) => [s.id, s]))
  const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))

  const linked = new Set(otherIds)
  const needle = q.trim().toLowerCase()
  const matches = needle
    ? candidates
      .filter((t) => t.id !== task.id && !linked.has(t.id))
      .filter((t) => t.title.toLowerCase().includes(needle) || t.key.toLowerCase().includes(needle))
      .slice(0, 8)
    : []

  const openWaits = rel.waitsOn.filter((l) => {
    const b = byId.get(l.fromTaskId)
    return b && !doneIds.has(b.statusId)
  }).length

  async function link(other: Task) {
    const r = adding === 'waitsOn' ? await repo.add(other.id, task.id) : await repo.add(task.id, other.id)
    if (!r.ok) { toast(r.reason ?? 'Could not link those', true); return }
    toast(adding === 'waitsOn' ? `${task.key} now waits on ${other.key}` : `${other.key} now waits on ${task.key}`)
    setQ(''); setAdding(null)
  }

  const row = (linkId: ID, other: Task | undefined, state: DependencyState) => (
    <div key={linkId} className="dep-row">
      {other ? (
        <button className="linkish" style={{ fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onClick={() => setParam('task', other.id)}>
          <span className="task-key" style={{ marginRight: 6 }}>{other.key}</span>{other.title}
        </button>
      ) : <span className="faint" style={{ flex: 1 }}>Loading…</span>}
      {other && other.teamId !== task.teamId && (
        <span className="chip solid">{teamById.get(other.teamId)?.name ?? 'Another team'}</span>
      )}
      {other && <span className="chip">{statusById.get(other.statusId)?.name}</span>}
      <StateChip state={state} />
      <button className="btn ghost sm" title="Remove this dependency" onClick={() => void repo.remove(linkId)}>×</button>
    </div>
  )

  return (
    <div>
      <p className="panel-title">
        Dependencies
        {openWaits > 0 && <span className="chip warn" style={{ fontWeight: 500 }}>waiting on {openWaits}</span>}
        <span className="spacer" />
        {!adding && (
          <>
            <button className="btn ghost sm" onClick={() => setAdding('waitsOn')}>Waits on…</button>
            <button className="btn ghost sm" onClick={() => setAdding('holdsUp')}>Holds up…</button>
          </>
        )}
      </p>

      {rel.waitsOn.length + rel.holdsUp.length === 0 && !adding && (
        <p className="small faint" style={{ margin: 0 }}>
          Nothing linked. Add what this waits on — another team's API, a design — and planning warns you when it is
          not scheduled to land first.
        </p>
      )}

      {rel.waitsOn.length > 0 && (
        <>
          <div className="attn-head" style={{ marginTop: 0 }}>Waits on</div>
          <div className="dep-list">
            {rel.waitsOn.map((l) => {
              const other = byId.get(l.fromTaskId)
              return row(l.id, other, dependencyState(other, task, sprintById, doneIds))
            })}
          </div>
        </>
      )}

      {rel.holdsUp.length > 0 && (
        <>
          <div className="attn-head">Holds up</div>
          <div className="dep-list">
            {rel.holdsUp.map((l) => {
              const other = byId.get(l.toTaskId)
              return row(l.id, other, dependencyState(task, other, sprintById, doneIds))
            })}
          </div>
        </>
      )}

      {adding && (
        <div className="dep-add">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="seg sm">
              <button className={adding === 'waitsOn' ? 'on' : ''} onClick={() => setAdding('waitsOn')}>This waits on</button>
              <button className={adding === 'holdsUp' ? 'on' : ''} onClick={() => setAdding('holdsUp')}>This holds up</button>
            </span>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => { setAdding(null); setQ('') }}>Cancel</button>
          </div>
          <input className="input" autoFocus placeholder="Find a task by key or title, in any team"
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); setQ('') }
              if (e.key === 'Enter' && matches[0]) void link(matches[0])
            }} />
          {needle && matches.length === 0 && <span className="small faint">Nothing matches that.</span>}
          {matches.length > 0 && (
            <div className="dep-list">
              {matches.map((t) => (
                <button key={t.id} className="dep-pick" onClick={() => void link(t)}>
                  <span className="task-key">{t.key}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  {t.teamId !== task.teamId && <span className="chip solid">{teamById.get(t.teamId)?.name}</span>}
                  <span className="chip">{statusById.get(t.statusId)?.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
