import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { ID, PiObjective, PiRisk, PiVote, RoamStatus, Sprint } from '../db/types'
import {
  pi as repo, piObjectives, piRisks, piVotes,
  settings as settingsRepo, sprints as sprintRepo,
} from '../repo'

const ROAM_LABEL: Record<RoamStatus, string> = {
  owned: 'Owned', mitigated: 'Mitigated', accepted: 'Accepted', resolved: 'Resolved',
}
const ROAM_CLASS: Record<RoamStatus, string> = {
  owned: 'warn', mitigated: '', accepted: 'solid', resolved: 'on',
}

function overlaps(sprint: Sprint, startDate: string, endDate: string): boolean {
  return sprint.startDate <= endDate && sprint.endDate >= startDate
}

function NewPi({
  teams, onClose, onCreated,
}: { teams: { id: ID; name: string }[]; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [teamIds, setTeamIds] = useState<ID[]>(teams.map((t) => t.id))

  async function create() {
    if (!start || !end) { toast('Pick a start and end date', true); return }
    const r = await repo.create({ name, startDate: start, endDate: end, teamIds })
    if (!r.ok || !r.pi) { toast(r.reason ?? 'Could not create that PI', true); return }
    onCreated(r.pi.id)
    toast(`${r.pi.name} planned`)
  }

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <p className="panel-title">New program increment</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <input className="input" placeholder="PI name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" type="date" style={{ width: 160 }} value={start} onChange={(e) => setStart(e.target.value)} />
          <span className="small faint">to</span>
          <input className="input" type="date" style={{ width: 160 }} value={end} onChange={(e) => setEnd(e.target.value)} />
          <span className="small faint">Usually 4–5 sprints plus an IP iteration.</span>
        </div>
        <div>
          <span className="label" style={{ display: 'block', marginBottom: 6 }}>Participating teams</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {teams.map((t) => (
              <button
                key={t.id}
                className={`chip btn-like${teamIds.includes(t.id) ? ' on' : ''}`}
                onClick={() => setTeamIds((ids) => (ids.includes(t.id) ? ids.filter((i) => i !== t.id) : [...ids, t.id]))}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!start || !end || teamIds.length === 0} onClick={create}>Create</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function PiPlanning() {
  const toast = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [objTeamId, setObjTeamId] = useState('')
  const [objTitle, setObjTitle] = useState('')
  const [riskText, setRiskText] = useState('')
  const [riskOwner, setRiskOwner] = useState('')

  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const people = useLiveQuery(() => db.people.filter((p) => p.active).sortBy('name'), [], [])
  const list = useLiveQuery(() => repo.list(), [], [])

  const current = list.find((p) => p.id === selectedId) ?? list.find((p) => p.state === 'active') ?? list[0] ?? null
  const currentTeamIds = current?.teamIds ?? []

  const objectives = useLiveQuery(
    () => (current ? piObjectives.listForPi(current.id) : Promise.resolve([] as PiObjective[])), [current?.id], [] as PiObjective[],
  )
  const risks = useLiveQuery(
    () => (current ? piRisks.listForPi(current.id) : Promise.resolve([] as PiRisk[])), [current?.id], [] as PiRisk[],
  )
  const votes = useLiveQuery(
    () => (current ? piVotes.listForPi(current.id) : Promise.resolve([] as PiVote[])), [current?.id], [] as PiVote[],
  )
  const teamSprints = useLiveQuery(
    () => (currentTeamIds.length ? db.sprints.where('teamId').anyOf(currentTeamIds).toArray() : Promise.resolve([] as Sprint[])),
    [currentTeamIds.join(',')], [] as Sprint[],
  )

  const teamById = new Map(teams.map((t) => [t.id, t]))
  const personById = new Map(people.map((p) => [p.id, p]))
  const piTeams = currentTeamIds.map((id) => teamById.get(id)).filter((t): t is NonNullable<typeof t> => !!t)

  async function save(id: string, patch: Parameters<typeof repo.update>[1]) {
    const r = await repo.update(id, patch)
    if (!r.ok) toast(r.reason ?? 'Could not save that', true)
  }

  async function planSprintFor(teamId: ID) {
    const s = await sprintRepo.plan({
      teamId,
      lengthDays: cfg?.sprintLengthDays ?? 14,
      startWeekday: cfg?.sprintStartWeekday ?? 1,
    })
    toast(`${s.name} planned for ${teamById.get(teamId)?.name ?? 'that team'}`)
  }

  const avgVote = votes.length ? votes.reduce((s, v) => s + v.vote, 0) / votes.length : null
  const lowVotes = votes.filter((v) => v.vote <= 2)

  return (
    <>
      <div className="topbar">
        <h1>PI Planning</h1>
        {current && <span className="chip on">{current.name}</span>}
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating((v) => !v)}>New PI</button>
      </div>

      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 980 }}>
        {creating && (
          <NewPi
            teams={teams}
            onClose={() => setCreating(false)}
            onCreated={(id) => { setSelectedId(id); setCreating(false) }}
          />
        )}

        {!current ? (
          <div className="empty">
            <strong>No program increment yet</strong>
            A PI spans several teams' sprints under one shared goal — usually 4–5 iterations plus a buffer. Create one
            and pick which teams are in it.
          </div>
        ) : (
          <>
            <div className="panel">
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <span className="label">Name</span>
                  <input className="inline-input" style={{ fontSize: 15, fontWeight: 650, marginTop: 2 }}
                    key={`${current.id}-name-${current.name}`} defaultValue={current.name}
                    onBlur={(e) => void save(current.id, { name: e.target.value })} />

                  <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    <input className="input" type="date" style={{ width: 142 }} value={current.startDate}
                      onChange={(e) => void save(current.id, { startDate: e.target.value })} />
                    <span className="small faint">to</span>
                    <input className="input" type="date" style={{ width: 142 }} value={current.endDate}
                      onChange={(e) => void save(current.id, { endDate: e.target.value })} />
                    <span className={`chip${current.state === 'active' ? ' on' : current.state === 'closed' ? ' solid' : ''}`}>
                      {current.state}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {teams.map((t) => (
                      <button
                        key={t.id}
                        className={`chip btn-like${currentTeamIds.includes(t.id) ? ' on' : ''}`}
                        onClick={() => void save(current.id, {
                          teamIds: currentTeamIds.includes(t.id)
                            ? currentTeamIds.filter((id) => id !== t.id)
                            : [...currentTeamIds, t.id],
                        })}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {current.state === 'planning' && (
                    <button className="btn" onClick={async () => {
                      const r = await repo.activate(current.id)
                      if (!r.ok) toast(r.reason ?? 'Could not start it', true)
                    }}>Start</button>
                  )}
                  {current.state === 'active' && (
                    <button className="btn primary" onClick={async () => { await repo.close(current.id); toast(`${current.name} closed`) }}>
                      Close
                    </button>
                  )}
                  <button className="btn ghost" onClick={async () => {
                    if (!confirm(`Delete ${current.name}? Its objectives, risks and votes go with it.`)) return
                    await repo.remove(current.id)
                    setSelectedId(null)
                  }}>Delete</button>
                </div>
              </div>
            </div>

            <div className="panel">
              <p className="panel-title">Program board<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>each team's iterations in this window</span></p>
              {piTeams.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>No teams in this PI yet — add one above.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {piTeams.map((t) => {
                    const inWindow = teamSprints
                      .filter((s) => s.teamId === t.id && overlaps(s, current.startDate, current.endDate))
                      .sort((a, b) => a.startDate.localeCompare(b.startDate))
                    return (
                      <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ width: 120, flex: 'none', fontWeight: 600 }}>{t.name}</span>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                          {inWindow.length === 0 && <span className="small faint">No sprints planned in this range.</span>}
                          {inWindow.map((s) => (
                            <span key={s.id} className={`chip${s.state === 'active' ? ' on' : s.state === 'closed' ? ' solid' : ''}`}>
                              {s.name} · {s.startDate}–{s.endDate}
                            </span>
                          ))}
                          <button className="btn sm ghost" onClick={() => void planSprintFor(t.id)}>Plan sprint</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="panel">
              <p className="panel-title">PI objectives</p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <select className="select" style={{ width: 150 }} value={objTeamId} onChange={(e) => setObjTeamId(e.target.value)}>
                  <option value="">Team…</option>
                  {piTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Objective, in business language"
                  value={objTitle} onChange={(e) => setObjTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && objTeamId && objTitle.trim()) { void piObjectives.add({ piId: current.id, teamId: objTeamId, title: objTitle }); setObjTitle('') } }} />
                <button className="btn primary" disabled={!objTeamId || !objTitle.trim()} onClick={async () => {
                  await piObjectives.add({ piId: current.id, teamId: objTeamId, title: objTitle })
                  setObjTitle('')
                }}>Add</button>
              </div>
              {objectives.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>No objectives yet. Business value is scored 1–10; stretch objectives are uncommitted.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {objectives.map((o) => (
                    <div key={o.id} className="row" style={{ borderTop: '1px solid var(--line)' }}>
                      <span className="chip solid" style={{ width: 100, flex: 'none', justifyContent: 'center' }}>
                        {teamById.get(o.teamId)?.name ?? '—'}
                      </span>
                      <input className="inline-input" style={{ flex: 1 }} key={`${o.id}-${o.title}`} defaultValue={o.title}
                        onBlur={(e) => void piObjectives.update(o.id, { title: e.target.value })} />
                      <button
                        className={`chip btn-like${o.committed ? ' on' : ''}`}
                        title="Toggle committed / stretch"
                        onClick={() => void piObjectives.update(o.id, { committed: !o.committed })}
                      >
                        {o.committed ? 'Committed' : 'Stretch'}
                      </button>
                      <input className="input" type="number" min={1} max={10} style={{ width: 56 }} value={o.businessValue}
                        title="Business value (1-10)"
                        onChange={(e) => void piObjectives.update(o.id, { businessValue: Number(e.target.value) })} />
                      {current.state === 'closed' && (
                        <input className="input" type="number" min={0} max={10} style={{ width: 76 }}
                          placeholder="Actual" value={o.actualValue ?? ''}
                          onChange={(e) => void piObjectives.update(o.id, { actualValue: e.target.value === '' ? null : Number(e.target.value) })} />
                      )}
                      <button className="btn ghost sm" onClick={() => void piObjectives.remove(o.id)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel">
              <p className="panel-title">Risks<span className="spacer" /><span className="faint" style={{ fontWeight: 400 }}>ROAM — Resolved, Owned, Accepted, Mitigated</span></p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="What could stop this PI from landing?"
                  value={riskText} onChange={(e) => setRiskText(e.target.value)} />
                <select className="select" style={{ width: 150 }} value={riskOwner} onChange={(e) => setRiskOwner(e.target.value)}>
                  <option value="">Owner…</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn primary" disabled={!riskText.trim()} onClick={async () => {
                  await piRisks.add({ piId: current.id, description: riskText, ownerPersonId: riskOwner || null })
                  setRiskText(''); setRiskOwner('')
                }}>Add</button>
              </div>
              {risks.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>No risks logged. Anything raised here gets a status, not a quiet hope it works out.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {risks.map((r) => (
                    <div key={r.id} className="row" style={{ borderTop: '1px solid var(--line)' }}>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <Avatar person={r.ownerPersonId ? personById.get(r.ownerPersonId) ?? null : null} size={20} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</span>
                      </div>
                      <button className={`chip btn-like ${ROAM_CLASS[r.status]}`} onClick={() => void piRisks.cycleStatus(r.id)}>
                        {ROAM_LABEL[r.status]}
                      </button>
                      <button className="btn ghost sm" onClick={() => void piRisks.remove(r.id)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel">
              <p className="panel-title">
                Confidence vote
                <span className="spacer" />
                {avgVote != null && <span className="faint" style={{ fontWeight: 400 }}>average {avgVote.toFixed(1)} / 5</span>}
              </p>
              {piTeams.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>Add teams to this PI to collect a vote.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {piTeams.map((t) => {
                      const v = votes.find((x) => x.teamId === t.id)
                      return (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 120, flex: 'none' }}>{t.name}</span>
                          <div className="seg">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <button key={n} className={v?.vote === n ? 'on' : ''} onClick={() => void piVotes.set(current.id, t.id, n)}>
                                {n}
                              </button>
                            ))}
                          </div>
                          {v == null && <span className="small faint">Not voted</span>}
                        </div>
                      )
                    })}
                  </div>
                  {lowVotes.length > 0 && (
                    <p className="small" style={{ color: 'var(--alert)', marginTop: 10, marginBottom: 0, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
                      {lowVotes.length} team{lowVotes.length === 1 ? '' : 's'} voted two fingers or fewer — worth talking through before calling this plan done.
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {list.length > 0 && (
          <div className="panel" style={{ padding: 0 }}>
            <p className="panel-title" style={{ padding: '12px 14px 8px', margin: 0 }}>All program increments</p>
            {list.map((p) => (
              <button
                key={p.id}
                className="row clickable"
                style={{
                  width: '100%', textAlign: 'left', color: 'inherit', font: 'inherit',
                  background: p.id === current?.id ? 'var(--surface-2)' : 'none', border: 0, borderTop: '1px solid var(--line)',
                }}
                onClick={() => setSelectedId(p.id)}
              >
                <b style={{ width: 160, flex: 'none' }}>{p.name}</b>
                <span className={`chip${p.state === 'active' ? ' on' : p.state === 'closed' ? ' solid' : ''}`}>{p.state}</span>
                <span className="small faint" style={{ flex: 1 }}>{p.startDate} – {p.endDate}</span>
                <span className="small faint">{p.teamIds.length} team{p.teamIds.length === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
