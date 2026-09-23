import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { db } from '../db/schema'
import { go, useRoute } from '../hooks/useRoute'
import { blockers, people, settings, teams as teamRepo } from '../repo'
import { useToast } from './Toast'

const NAV = [
  { id: 'today', label: 'Today' },
  { id: 'board', label: 'Board' },
  { id: 'blockers', label: 'Blockers' },
  { id: 'standup', label: 'Stand-up' },
  { id: 'boards', label: 'Boards' },
  { id: 'notes', label: 'Notes' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'pi', label: 'PI Planning' },
  { id: 'people', label: 'People' },
]

function TeamSwitcher({ activeTeamId }: { activeTeamId: string | null }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const wrap = useRef<HTMLDivElement>(null)

  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const taskCounts = useLiveQuery(async () => {
    const out: Record<string, number> = {}
    for (const t of await db.teams.toArray()) out[t.id] = await db.tasks.where('teamId').equals(t.id).count()
    return out
  }, [], {} as Record<string, number>)

  const active = teams.find((t) => t.id === activeTeamId) ?? teams[0]

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) { setOpen(false); setAdding(false) }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  async function create() {
    if (!name.trim()) return
    const team = await teamRepo.create({ name })
    await settings.setActiveTeam(team.id)
    setName(''); setAdding(false); setOpen(false)
    toast(`${team.name} created — add people to it next`)
    go('people')
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button className="switcher" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{active?.name ?? 'No team'}</span>
        <small>{teams.length > 1 ? `${teams.length} teams` : ''} ▾</small>
      </button>

      {open && (
        <div className="team-pop">
          {teams.map((t) => (
            <button
              key={t.id}
              className={`team-opt${t.id === active?.id ? ' on' : ''}`}
              onClick={async () => { await settings.setActiveTeam(t.id); setOpen(false) }}
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{t.name}</span>
              <span className="small faint">{t.keyPrefix}</span>
              <span className="small faint">{taskCounts[t.id] ?? 0}</span>
            </button>
          ))}
          <div className="team-pop-foot">
            {adding ? (
              <div style={{ display: 'flex', gap: 5 }}>
                <input
                  className="input" autoFocus placeholder="Team name" value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setAdding(false) }}
                />
                <button className="btn primary sm" disabled={!name.trim()} onClick={create}>Add</button>
              </div>
            ) : (
              <button className="team-opt" onClick={() => setAdding(true)}>
                <span style={{ flex: 1, textAlign: 'left' }}>New team…</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function Shell({ children }: { children: React.ReactNode }) {
  const route = useRoute()
  const [open, setOpen] = useState(false)
  const cfg = useLiveQuery(() => settings.get(), [])
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const activeTeamId = (teams.find((t) => t.id === cfg?.activeTeamId) ?? teams[0])?.id ?? null

  const peopleCount = useLiveQuery(
    async () => (activeTeamId ? (await people.listActiveForTeam(activeTeamId)).length : 0),
    [activeTeamId], 0,
  )
  const blockedCount = useLiveQuery(
    async () => (activeTeamId ? (await blockers.openForTeam(activeTeamId)).length : 0),
    [activeTeamId], 0,
  )
  const boardCount = useLiveQuery(() => db.boards.count(), [], 0)

  return (
    <div className="app">
      <nav className={`rail${open ? ' open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">Scrumly</span>
        </div>

        <TeamSwitcher activeTeamId={activeTeamId} />

        <ul className="nav">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className={route.screen === item.id || (item.id === 'boards' && route.screen === 'canvas') ? 'on' : ''}
                onClick={() => { go(item.id); setOpen(false) }}
              >
                <span className="dot-ico" />
                {item.label}
                {item.id === 'people' && <span className="count">{peopleCount}</span>}
                {item.id === 'blockers' && blockedCount > 0 && <span className="count hot">{blockedCount}</span>}
                {item.id === 'boards' && boardCount > 0 && <span className="count">{boardCount}</span>}
              </button>
            </li>
          ))}
        </ul>

        <div className="rail-foot">
          <ul className="nav">
            <li>
              <button className={route.screen === 'settings' ? 'on' : ''} onClick={() => { go('settings'); setOpen(false) }}>
                <span className="dot-ico" />
                Settings
              </button>
            </li>
          </ul>
        </div>
      </nav>

      <div className="main">
        <button className="menu-toggle btn ghost" onClick={() => setOpen((v) => !v)}>Menu</button>
        {children}
      </div>
    </div>
  )
}
