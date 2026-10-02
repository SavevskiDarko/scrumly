import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { db } from '../db/schema'
import { go, useRoute } from '../hooks/useRoute'
import { blockers, people, settings, sheets, teams as teamRepo } from '../repo'
import { useToast } from './Toast'

const NAV = [
  { id: 'today', label: 'Today' },
  { id: 'board', label: 'Board' },
  { id: 'blockers', label: 'Blockers' },
  { id: 'standup', label: 'Stand-up' },
  { id: 'boards', label: 'Boards' },
  { id: 'sheets', label: 'Sheets' },
  { id: 'notes', label: 'Notes' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'planning', label: 'Sprint planning' },
  { id: 'pi', label: 'PI Planning' },
  { id: 'people', label: 'People' },
]

// Per-device, like the theme: a narrow laptop wants it tucked away, a wide monitor doesn't.
const RAIL_KEY = 'scrumly-rail-collapsed'

function readCollapsed() {
  try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
}

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
  const [collapsed, setCollapsed] = useState(readCollapsed)
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
  const sheetCount = useLiveQuery(
    async () => (activeTeamId ? (await sheets.listForTeam(activeTeamId)).length : 0),
    [activeTeamId], 0,
  )

  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0') } catch { /* private mode */ }
  }, [collapsed])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'b') return
      // The canvas has its own shortcuts; leave its keys alone.
      if ((e.target as Element | null)?.closest?.('.excalidraw')) return
      e.preventDefault()
      setCollapsed((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <nav className={`rail${open ? ' open' : ''}${collapsed ? ' collapsed' : ''}`}>
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">Scrumly</span>
          <span className="brand-version" title={`Scrumly ${__APP_VERSION__}`}>v{__APP_VERSION__}</span>
          <button
            className="rail-toggle"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Show menu (Ctrl+B)' : 'Hide menu (Ctrl+B)'}
            aria-label={collapsed ? 'Show menu' : 'Hide menu'}
            aria-expanded={!collapsed}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={collapsed ? 'M6 3.5 10.5 8 6 12.5' : 'M10 3.5 5.5 8 10 12.5'} />
            </svg>
          </button>
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
                {item.id === 'sheets' && sheetCount > 0 && <span className="count">{sheetCount}</span>}
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
