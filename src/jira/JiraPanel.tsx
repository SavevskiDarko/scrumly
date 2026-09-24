import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Status, Team } from '../db/types'
import { jiraBridge, type JiraConnection } from '../desktop/bridge'
import { settings as settingsRepo } from '../repo'
import { autoColumn, jiraLinks, type JiraBoard, type JiraBoardConfig, type JiraStatus } from '../repo/jira'
import { boardStatuses, pullTeam, searchBoards } from './pull'
import { AUTO_PULL_MINUTES } from './useJiraAutoPull'

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}

const host = (site: string) => site.replace(/^https?:\/\//, '')

function LastPull({ team }: { team: Team }) {
  const last = team.jira?.lastPull
  if (!last) return <span className="small faint">Not pulled yet.</span>
  return (
    <span className="small" style={{ color: last.ok ? 'var(--muted)' : 'var(--alert)' }}>
      Last pull {ago(last.at)} — {last.message}
    </span>
  )
}

function Connect({ encryption, onDone }: { encryption: boolean; onDone: () => void }) {
  const [site, setSite] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cloud = /atlassian\.net|jira\.com/i.test(site)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await jiraBridge()!.connect({ site, email, token })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setToken('')
    onDone()
  }

  if (!encryption) {
    return (
      <p className="small" style={{ color: 'var(--alert)', margin: 0 }}>
        This computer cannot encrypt a stored token, so Scrumly will not keep one. Jira import is unavailable here.
      </p>
    )
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
      <input className="input" placeholder="yourcompany.atlassian.net, or your Jira server's address" value={site}
        onChange={(e) => setSite(e.target.value)} autoComplete="url" />
      <input className="input" type="email" placeholder={cloud ? 'The email you sign in to Jira with' : 'Email — Jira Cloud only'}
        value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      <input className="input" type="password" placeholder={cloud || email ? 'API token' : 'API token or personal access token'}
        value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy || !site.trim() || !token.trim() || (cloud && !email.trim())}>
          {busy ? 'Checking with Jira…' : 'Connect'}
        </button>
        {error && <span className="small" style={{ color: 'var(--alert)' }}>{error}</span>}
      </div>
      <p className="small faint" style={{ margin: 0 }}>
        <b>Jira Cloud:</b> your email and an API token from{' '}
        <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">id.atlassian.com → Security → API tokens</a>.{' '}
        <b>Server or Data Center:</b> leave the email empty and use a personal access token from your Jira profile.
        The token is encrypted by Windows and stays on this computer — it is never synced, backed up or saved with your data.
      </p>
    </form>
  )
}

function FindBoard({ team, site }: { team: Team; site: string }) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [boards, setBoards] = useState<JiraBoard[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function search(e?: React.FormEvent) {
    e?.preventDefault()
    setBusy(true)
    try { setBoards(await searchBoards(q)) } catch (err) { toast(err instanceof Error ? err.message : 'Could not list boards', true) }
    setBusy(false)
  }

  useEffect(() => { void search() }, [])

  async function link(board: JiraBoard) {
    await jiraLinks.link(team.id, { site, boardId: board.id, boardName: board.name })
    toast(`${team.name} now follows ${board.name} — pulling`)
    const r = await pullTeam(team.id)
    toast(r.message, !r.ok)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p className="muted" style={{ margin: 0 }}>Pick the Jira board <b>{team.name}</b> should follow.</p>
      <form onSubmit={search} style={{ display: 'flex', gap: 6, maxWidth: 420 }}>
        <input className="input" placeholder="Board name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={busy}>{busy ? 'Looking…' : 'Find'}</button>
      </form>
      {boards && boards.length === 0 && <span className="small faint">No scrum boards match. Kanban boards have no sprints to bring in.</span>}
      {boards && boards.length > 0 && (
        <div className="jira-boards">
          {boards.map((b) => (
            <div key={b.id} className="jira-board">
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{b.name}</b>
                {b.location?.projectKey && <span className="small faint"> · {b.location.projectKey}</span>}
              </span>
              <button className="btn sm" onClick={() => void link(b)}>Follow</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusMapping({ team, columns }: { team: Team; columns: Status[] }) {
  const [data, setData] = useState<{ config: JiraBoardConfig; statuses: JiraStatus[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const link = team.jira!

  useEffect(() => {
    let live = true
    boardStatuses(link.boardId)
      .then((d) => { if (live) setData(d) })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'Could not read the board') })
    return () => { live = false }
  }, [link.boardId])

  if (error) return <p className="small" style={{ color: 'var(--alert)', margin: 0 }}>{error}</p>
  if (!data) return <p className="small faint" style={{ margin: 0 }}>Reading the board…</p>

  const byId = new Map(data.statuses.map((s) => [s.id, s]))
  const boardColumns = data.config.columnConfig?.columns ?? []
  return (
    <div className="jira-map">
      {boardColumns.flatMap((bc) => bc.statuses.map((ref) => {
        const status = byId.get(ref.id)
        const auto = autoColumn(status, columns, data.config)
        return (
          <div key={ref.id} className="jira-map-row">
            <span className="small faint jira-map-col">{bc.name}</span>
            <span className="jira-map-status">{status?.name ?? ref.id}</span>
            <span className="faint">→</span>
            <select className="select" value={link.statusMap[ref.id] ?? ''}
              onChange={(e) => void jiraLinks.mapStatus(team.id, ref.id, e.target.value || null)}>
              <option value="">Automatic — {auto?.name ?? 'first column'}</option>
              {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )
      }))}
    </div>
  )
}

function Linked({ team, conn }: { team: Team; conn: JiraConnection }) {
  const toast = useToast()
  const [pulling, setPulling] = useState(false)
  const [mapping, setMapping] = useState(false)
  const columns = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [] as Status[])
  const link = team.jira!

  if (link.site !== conn.site) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="small" style={{ color: 'var(--alert)', margin: 0 }}>
          {team.name} follows <b>{link.boardName}</b> on {host(link.site)}, but this app is connected to {host(conn.site ?? '')}.
          Connect to that site to keep pulling, or stop following it.
        </p>
        <div><button className="btn sm" onClick={() => void jiraLinks.unlink(team.id)}>Stop following</button></div>
      </div>
    )
  }

  async function pull() {
    setPulling(true)
    const r = await pullTeam(team.id)
    setPulling(false)
    toast(r.message, !r.ok)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span><b>{team.name}</b> follows <b>{link.boardName}</b></span>
        <span className="spacer" />
        <button className="btn primary sm" disabled={pulling} onClick={() => void pull()}>{pulling ? 'Pulling…' : 'Pull now'}</button>
      </div>
      <LastPull team={team} />

      <label className="jira-check">
        <input type="checkbox" checked={link.auto} onChange={(e) => void jiraLinks.update(team.id, { auto: e.target.checked })} />
        Pull on start-up and every {AUTO_PULL_MINUTES} minutes while this app is open
      </label>
      <label className="jira-check">
        <input type="checkbox" checked={link.includeBacklog}
          onChange={(e) => void jiraLinks.update(team.id, { includeBacklog: e.target.checked })} />
        Also bring in the board's backlog, not just what is in sprints
      </label>

      <div>
        <button className="btn ghost sm" onClick={() => setMapping((v) => !v)} aria-expanded={mapping}>
          {mapping ? 'Hide' : 'Show'} which column each Jira status lands in
          {Object.keys(link.statusMap).length > 0 && ` (${Object.keys(link.statusMap).length} set by hand)`}
        </button>
        {mapping && <div style={{ marginTop: 8 }}><StatusMapping team={team} columns={columns} /></div>}
      </div>

      <p className="small faint" style={{ margin: 0 }}>
        Jira owns what it knows: a pull overwrites each issue's title, status, sprint, assignee, points and dates, and
        brings its history so burndown, velocity and KPIs work. Reviewer, tester, blockers and dependencies are
        Scrumly's own and are never touched.
      </p>
      <div>
        <button className="btn ghost sm" onClick={() => {
          if (confirm(`Stop pulling ${link.boardName} into ${team.name}? Everything already imported stays.`)) void jiraLinks.unlink(team.id)
        }}>Stop following this board</button>
      </div>
    </div>
  )
}

export function JiraPanel() {
  const bridge = jiraBridge()
  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [] as Team[])
  const [conn, setConn] = useState<JiraConnection | null>(null)

  const refresh = useCallback(() => { if (bridge) void bridge.status().then(setConn) }, [bridge])
  useEffect(() => { refresh() }, [refresh])

  const team = teams.find((t) => t.id === cfg?.activeTeamId) ?? teams[0]
  const others = teams.filter((t) => t.jira && t.id !== team?.id)

  const otherList = others.length > 0 && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
      {others.map((t) => (
        <div key={t.id} className="small">
          <b>{t.name}</b> <span className="muted">follows {t.jira!.boardName}.</span> <LastPull team={t} />
        </div>
      ))}
    </div>
  )

  if (!bridge) {
    const linked = teams.filter((t) => t.jira)
    return (
      <div className="panel">
        <p className="panel-title">Jira</p>
        <p className="muted" style={{ marginTop: 0, marginBottom: linked.length ? 10 : 0 }}>
          Pulling sprints and issues from Jira runs in the Scrumly desktop app: Jira does not answer a web page
          directly. Link a board there, and what it brings in reaches this device through sync.
        </p>
        {linked.map((t) => (
          <div key={t.id} className="small">
            <b>{t.name}</b> <span className="muted">follows {t.jira!.boardName}.</span> <LastPull team={t} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="panel">
      <p className="panel-title">
        Jira
        <span className="spacer" />
        {conn?.connected && conn.site && (
          <span className="faint" style={{ fontWeight: 400 }}>{host(conn.site)} · {conn.user}</span>
        )}
      </p>

      {!conn ? (
        <p className="small faint" style={{ margin: 0 }}>Checking…</p>
      ) : !conn.connected ? (
        <Connect encryption={conn.encryption} onDone={refresh} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {team && (team.jira ? <Linked team={team} conn={conn} /> : <FindBoard team={team} site={conn.site!} />)}
          {otherList}
          <div style={{ paddingTop: 10, borderTop: '1px solid var(--line)' }}>
            <button className="btn ghost sm" onClick={async () => {
              if (!confirm('Disconnect from Jira? The token is deleted from this computer; imported work stays.')) return
              await bridge.disconnect()
              refresh()
            }}>Disconnect from Jira</button>
          </div>
        </div>
      )}
    </div>
  )
}
