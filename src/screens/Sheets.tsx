import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Sheet } from '../db/types'
import { googleBridge, sheetsBridge } from '../desktop/bridge'
import { setParam, useRoute } from '../hooks/useRoute'
import {
  NOT_A_SHEET, browserUrl, embedUrl, parseSheetUrl, sheets as sheetRepo, signInTarget, type SheetRef,
} from '../repo'
import { GoogleConnect, useGoogleConnection } from '../sheets/GoogleConnect'
import { SheetTable } from '../sheets/SheetTable'
import { viewFor } from '../sheets/table'

// Per device, like the rail: which sheet was open last, so coming back lands on it.
const LAST_KEY = 'scrumly-sheet-last'

function readLast(): string | null {
  try { return localStorage.getItem(LAST_KEY) } catch { return null }
}
function writeLast(id: string) {
  try { localStorage.setItem(LAST_KEY, id) } catch { /* private mode */ }
}

/**
 * Which sheets Google has asked to sign in for, in the desktop app. Google
 * will not sign anyone in there, so those show as a table through its API, or
 * open in a window of the user's own browser. The browser build has none of
 * this: a sheet there uses whatever Google account the browser is signed in to.
 */
function usePrivateSheets(currentFileId: string | null) {
  const [bridge] = useState(sheetsBridge)
  // File ids whose frame landed on Google's sign-in page.
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set())
  const current = useRef(currentFileId)
  current.current = currentFileId

  useEffect(() => {
    if (!bridge) return
    return bridge.onSignInNeeded((url, clicked) => {
      // A click on the sheet's own Sign in button came from the sheet on
      // screen, even when Google's address does not say which one it was.
      const fileId = signInTarget(url) ?? (clicked ? current.current : null)
      if (fileId) setRefused((r) => new Set(r).add(fileId))
    })
  }, [bridge])

  /** A reload asks Google again, so what it said last time no longer stands. */
  function forget(fileId: string) {
    setRefused((r) => {
      if (!r.has(fileId)) return r
      const next = new Set(r)
      next.delete(fileId)
      return next
    })
  }

  return { bridge, refused, forget }
}

export function Sheets({ teamId }: { teamId: string }) {
  const toast = useToast()
  const route = useRoute()
  const rows = useLiveQuery(() => sheetRepo.listForTeam(teamId), [teamId])
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const [api] = useState(() => googleBridge() !== null)
  const conn = useGoogleConnection()
  const [connecting, setConnecting] = useState(false)
  const [editing, setEditing] = useState<Sheet | 'new' | null>(null)
  // Sheets already opened stay loaded behind the one on screen, so flipping
  // between two is instant and each keeps its place.
  const [opened, setOpened] = useState<string[]>([])
  // Bumped to reload one sheet: a new key is a new frame, or a new read.
  const [loads, setLoads] = useState<Record<string, number>>({})

  const wanted = route.params.get('sheet') ?? readLast()
  const current = rows?.find((s) => s.id === wanted) ?? rows?.[0] ?? null
  const currentRef = current ? parseSheetUrl(current.url) : null
  const priv = usePrivateSheets(currentRef?.fileId ?? null)
  const can = { api, connected: Boolean(conn?.connected) }
  const view = (s: Sheet) => viewFor(s, parseSheetUrl(s.url), can)

  useEffect(() => {
    if (!current) return
    setOpened((o) => (o.includes(current.id) ? o : [...o, current.id]))
    writeLast(current.id)
  }, [current?.id])

  async function openWindow(ref: SheetRef) {
    if (!priv.bridge) return
    const where = await priv.bridge.openWindow(browserUrl(ref))
    if (where === null) toast(NOT_A_SHEET, true)
    else toast(where === 'browser' ? 'Opened in your browser' : `Opened in a ${where} window`)
  }

  if (rows === undefined) return null

  const currentView = current ? view(current) : 'editor'
  const isPrivate = Boolean(priv.bridge && currentRef && currentView === 'editor' && priv.refused.has(currentRef.fileId))

  return (
    <>
      <div className="topbar">
        <h1>Sheets</h1>
        <span className="chip solid">{rows.length}</span>
        <span className="spacer" />
        {api && conn && (conn.connected
          ? <button className="chip ok btn-like" title="Private sheets show here through Google's API" onClick={() => setConnecting(true)}>
            Google: {conn.email ?? 'connected'}
          </button>
          : <button className="btn" onClick={() => setConnecting(true)}>Connect Google</button>)}
        <button className="btn primary" onClick={() => setEditing('new')}>Add sheet</button>
      </div>

      {rows.length === 0 ? (
        <div className="screen pad">
          <div className="empty">
            <strong>No sheets yet</strong>
            Paste a Google Sheets link and it opens here, live — edit it in place, and it is never a stale copy.
            Only the link is kept in Scrumly.
            <div style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => setEditing('new')}>Add a Google Sheet</button>
            </div>
            <p className="small" style={{ marginTop: 14 }}>
              {api
                ? 'Sheets shared with "anyone with the link" open right here in Google\'s editor. Private ones show here as a table once you Connect Google.'
                : 'Private sheets open with the Google account this browser is signed in to.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="sheet-tabs" role="tablist" aria-label="Sheets">
            {rows.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === current?.id}
                className={`sheet-tab${s.id === current?.id ? ' on' : ''}`}
                title={s.teamId === null ? `${s.title} — every team` : s.title}
                onClick={() => setParam('sheet', s.id)}
                onDoubleClick={() => setEditing(s)}
              >
                {s.title}
                {s.teamId === null && <span className="sheet-tab-all" aria-hidden="true">all</span>}
              </button>
            ))}
            <span className="spacer" />
            {current && currentRef && (
              <div className="sheet-actions">
                {api && !currentRef.published && (
                  <div className="seg sm" title="Google's editor, or the sheet's values read into a table — the way a private sheet shows here">
                    <button className={currentView === 'editor' ? 'on' : ''}
                      onClick={() => sheetRepo.update(current.id, { view: 'editor' })}>Google editor</button>
                    <button className={currentView === 'table' ? 'on' : ''}
                      onClick={() => sheetRepo.update(current.id, { view: 'table' })}>Table</button>
                  </div>
                )}
                <button className="btn ghost sm" title="Load the sheet again from Google" onClick={() => {
                  priv.forget(currentRef.fileId)
                  setLoads((l) => ({ ...l, [current.id]: (l[current.id] ?? 0) + 1 }))
                }}>Reload</button>
                {priv.bridge
                  ? <button className="btn ghost sm" title="Open it in a window of your own Chrome or Edge"
                    onClick={() => openWindow(currentRef)}>Open in window</button>
                  : <a className="btn ghost sm" href={browserUrl(currentRef)} target="_blank" rel="noreferrer">Open in browser</a>}
                <button className="btn ghost sm" onClick={() => setEditing(current)}>Edit</button>
              </div>
            )}
          </div>

          <div className="sheet-stage">
            {rows.filter((s) => opened.includes(s.id) && view(s) === 'editor').map((s) => {
              const ref = parseSheetUrl(s.url)
              if (!ref) return null
              return (
                <iframe
                  key={`${s.id}:${s.url}:${loads[s.id] ?? 0}`}
                  className={`sheet-frame${s.id === current?.id ? '' : ' hidden'}`}
                  src={embedUrl(ref)}
                  title={s.title}
                  allow="clipboard-read; clipboard-write; fullscreen"
                />
              )
            })}
            {current && !currentRef && (
              <div className="sheet-cover"><div className="empty"><strong>That link no longer reads as a sheet</strong>{NOT_A_SHEET}</div></div>
            )}
            {current && currentRef && currentView === 'table' && (
              <SheetTable
                key={`${current.id}:${current.url}`}
                sheetRef={currentRef}
                connected={can.connected}
                reload={loads[current.id] ?? 0}
                onConnect={() => setConnecting(true)}
              />
            )}
            {isPrivate && currentRef && current && (
              <div className="sheet-cover">
                <div className="empty">
                  <strong>This sheet is private</strong>
                  Google only shows it to an account that can open it, and does not let anyone sign in inside a
                  desktop app. {can.connected
                    ? 'Your Google connection can show it here as a table.'
                    : 'Connect Google once, through your browser, and it shows here as a table.'}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
                    {can.connected
                      ? <button className="btn primary" onClick={() => sheetRepo.update(current.id, { view: 'table' })}>Show it here</button>
                      : api && <button className="btn primary" onClick={() => setConnecting(true)}>Connect Google</button>}
                    <button className="btn" onClick={() => openWindow(currentRef)}>Open in window</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {editing && (
        <SheetForm
          sheet={editing === 'new' ? null : editing}
          teamId={teamId}
          teamName={team?.name ?? 'this team'}
          onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); setParam('sheet', id) }}
        />
      )}
      {connecting && <GoogleConnect onClose={() => setConnecting(false)} />}
    </>
  )
}

function SheetForm({ sheet, teamId, teamName, onClose, onSaved }: {
  sheet: Sheet | null
  teamId: string
  teamName: string
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const toast = useToast()
  const [url, setUrl] = useState(sheet?.url ?? '')
  const [title, setTitle] = useState(sheet?.title ?? '')
  const [everyTeam, setEveryTeam] = useState(sheet?.teamId === null)
  const [error, setError] = useState<string | null>(null)
  const ref = parseSheetUrl(url)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save() {
    if (!ref) return
    const scope = everyTeam ? null : teamId
    if (sheet) {
      const res = await sheetRepo.update(sheet.id, { url, title, teamId: scope })
      if (!res.ok) { setError(res.reason ?? NOT_A_SHEET); return }
      onSaved(sheet.id)
    } else {
      const res = await sheetRepo.add({ url, title, teamId: scope })
      if (!res.ok) { setError(res.reason); return }
      toast(`${res.sheet.title} added`)
      onSaved(res.sheet.id)
    }
  }

  async function remove() {
    if (!sheet || !confirm(`Remove ${sheet.title} from Scrumly? The sheet itself stays in Google.`)) return
    await sheetRepo.remove(sheet.id)
    toast(`${sheet.title} removed`)
    onClose()
  }

  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void save() }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-label={sheet ? 'Edit sheet' : 'Add a Google Sheet'} style={{ maxWidth: 540 }}>
        <div className="modal-head">
          <b>{sheet ? 'Edit sheet' : 'Add a Google Sheet'}</b>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label className="field">
            <span className="label">Link</span>
            <input
              className="input" autoFocus={!sheet} value={url} onKeyDown={enter}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              onChange={(e) => { setUrl(e.target.value); setError(null) }}
            />
            {url.trim() && !ref && <span className="small" style={{ color: 'var(--alert)' }}>{NOT_A_SHEET}</span>}
            {ref?.published && <span className="small faint">Published to the web: opens read-only, for anyone.</span>}
            {ref && !ref.published && ref.gid && <span className="small faint">Opens on the tab the link was copied from.</span>}
          </label>
          <label className="field">
            <span className="label">Name</span>
            <input
              className="input" autoFocus={Boolean(sheet)} value={title} onKeyDown={enter}
              placeholder="Capacity, roadmap, release plan…"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
            <input type="checkbox" checked={everyTeam} onChange={(e) => setEveryTeam(e.target.checked)} />
            Show it for every team, not only {teamName}
          </label>
          {error && <span className="small" style={{ color: 'var(--alert)' }}>{error}</span>}
        </div>
        <div className="modal-foot">
          {sheet && <button className="btn danger" onClick={remove}>Remove</button>}
          <span className="small faint">Only the link is kept. The sheet stays in Google.</span>
          <span className="spacer" />
          <button className="btn primary" disabled={!ref} onClick={save}>{sheet ? 'Save' : 'Add sheet'}</button>
        </div>
      </div>
    </>
  )
}
