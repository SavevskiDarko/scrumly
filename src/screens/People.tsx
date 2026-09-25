import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { db } from '../db/schema'
import type { Person, Status, Task } from '../db/types'
import { useKpiReadings } from '../hooks/useKpis'
import { setParam } from '../hooks/useRoute'
import { ROLES, kpiSummary, people as peopleRepo } from '../repo'

function AddPerson({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('Developer')
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <p className="panel-title">Add someone</p>
      <div className="person-row">
        <input className="input" autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { void peopleRepo.create({ name, role, teamIds: [teamId] }); setName('') } }} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <button className="btn primary" disabled={!name.trim()}
          onClick={async () => { await peopleRepo.create({ name, role, teamIds: [teamId] }); setName('') }}>Add</button>
        <button className="btn ghost" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

export function People({ teamId }: { teamId: string }) {
  const [adding, setAdding] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [scope, setScope] = useState<'team' | 'all'>('team')
  const everyone = useLiveQuery(() => db.people.orderBy('name').toArray(), [], [])
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])

  const thisTeam = teams.find((t) => t.id === teamId)
  const orphans = everyone.filter((p) => p.active && p.teamIds.length === 0)
  const list = everyone
    .filter((p) => showInactive || p.active)
    .filter((p) => scope === 'all' || p.teamIds.includes(teamId))
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  const activeStatusIds = new Set(statuses.filter((s) => s.countsAsActive).map((s) => s.id))
  const kpiReadings = useKpiReadings(list)

  function workFor(p: Person): { active: Task[]; all: Task[] } {
    const mine = tasks.filter((t) => t.assigneeId === p.id || t.reviewerId === p.id || t.testerId === p.id)
    return { active: mine.filter((t) => activeStatusIds.has(t.statusId)), all: mine }
  }

  const counts = list.map((p) => workFor(p).active.length)
  const busiest = Math.max(1, ...counts)

  return (
    <>
      <div className="topbar">
        <h1>People</h1>
        {teams.length > 1 && (
          <div className="seg">
            <button className={scope === 'team' ? 'on' : ''} onClick={() => setScope('team')}>
              {thisTeam?.name ?? 'This team'}
            </button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>Everyone</button>
          </div>
        )}
        <span className="chip solid">{list.length}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setShowInactive((v) => !v)}>
          {showInactive ? 'Hide inactive' : 'Show inactive'}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>Add person</button>
      </div>

      <div className="screen pad">
        {adding && <AddPerson teamId={teamId} onClose={() => setAdding(false)} />}

        {orphans.length > 0 && scope === 'team' && (
          <div className="panel" style={{ marginBottom: 12, borderColor: 'var(--alert)' }}>
            <p className="panel-title" style={{ color: 'var(--alert)' }}>In no team</p>
            <p className="small muted" style={{ marginTop: 0 }}>
              {orphans.map((p) => p.name).join(', ')} {orphans.length === 1 ? 'is' : 'are'} in no team, so
              {orphans.length === 1 ? ' they do' : ' they do'} not appear on any board or in any stand-up.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {orphans.map((p) => (
                <button key={p.id} className="btn sm" onClick={() => peopleRepo.toggleTeam(p.id, teamId)}>
                  Add {p.name.split(' ')[0]} to {thisTeam?.name ?? 'this team'}
                </button>
              ))}
            </div>
          </div>
        )}

        {list.length === 0 ? (
          <div className="empty">
            <strong>Nobody in {thisTeam?.name ?? 'this team'} yet</strong>
            Add the people on this team and their work will start showing up here. Somebody can belong to more than
            one team — add them from either side.
          </div>
        ) : (
          <div className="rows">
            <div className="row-head">
              <span style={{ width: 180 }}>Person</span>
              <span style={{ flex: 1 }}>Working on</span>
              <span style={{ width: 120 }}>Load</span>
              <span style={{ width: 130 }}>KPIs</span>
              {teams.length > 1 && <span style={{ width: 150 }}>Teams</span>}
              <span style={{ width: 70 }} />
            </div>
            {list.map((p) => {
              const { active } = workFor(p)
              const share = Math.round((active.length / busiest) * 100)
              const kpi = kpiSummary(kpiReadings.get(p.id) ?? [])
              return (
                <div key={p.id} className="row">
                  <div style={{ width: 180, display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Avatar person={p} size={30} dim={!p.active} />
                    <div style={{ minWidth: 0 }}>
                      <button className="linkish" onClick={() => setParam('member', p.id)}>{p.name}</button>
                      <div className="small faint">{p.role}{!p.active && ' · inactive'}</div>
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {active.slice(0, 2).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setParam('task', t.id)}
                        style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 7, alignItems: 'center' }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                        <span className="chip">{statusById.get(t.statusId)?.name}</span>
                      </button>
                    ))}
                    {active.length > 2 && <span className="small faint">+ {active.length - 2} more</span>}
                    {active.length === 0 && <span className="small faint">Nothing active</span>}
                  </div>

                  <div style={{ width: 120 }}>
                    <div className="bar"><i className={share > 80 ? 'hot' : ''} style={{ width: `${share}%` }} /></div>
                    <div className="small faint" style={{ marginTop: 4 }}>{active.length} active</div>
                  </div>

                  <div style={{ width: 130 }}>
                    {kpi.tracked === 0 ? (
                      <button className="btn ghost sm" onClick={() => setParam('member', p.id)}>Add KPIs</button>
                    ) : (
                      <button
                        className={`chip btn-like${kpi.missed ? ' warn' : kpi.judged && kpi.met === kpi.judged ? ' ok' : ''}`}
                        title={kpi.tracked > kpi.judged
                          ? `${kpi.tracked - kpi.judged} of ${kpi.tracked} not judged yet — no target, or no reading`
                          : undefined}
                        onClick={() => setParam('member', p.id)}
                      >
                        {kpi.judged ? `${kpi.met} of ${kpi.judged} on target` : `${kpi.tracked} tracked`}
                      </button>
                    )}
                  </div>

                  {teams.length > 1 && (
                    <div style={{ width: 150, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {teams.map((t) => (
                        <button
                          key={t.id}
                          className={`chip btn-like${p.teamIds.includes(t.id) ? ' on' : ''}`}
                          title={p.teamIds.includes(t.id) ? `Remove from ${t.name}` : `Add to ${t.name}`}
                          onClick={() => peopleRepo.toggleTeam(p.id, t.id)}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{ width: 70, textAlign: 'right' }}>
                    <button className="btn ghost sm" onClick={() => peopleRepo.setActive(p.id, !p.active)}>
                      {p.active ? 'Archive' : 'Restore'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="small faint" style={{ marginTop: 14, maxWidth: '60ch' }}>
          Load counts anything sitting in a column marked as active work — In progress, Code review and QA by default,
          and only work belonging to {thisTeam?.name ?? 'this team'}. Change which columns count in Settings.
        </p>
      </div>
    </>
  )
}
