import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Sheet } from '../db/types'
import { googleBridge, type GoogleStatus } from '../desktop/bridge'
import { setParam, useRoute } from '../hooks/useRoute'
import { NOT_A_SHEET, browserUrl, embedUrl, parseSheetUrl, sheets as sheetRepo, signInTarget } from '../repo'

// Per device, like the rail: which sheet was open last, so coming back lands on it.
const LAST_KEY = 'scrumly-sheet-last'

function readLast(): string | null {
  try { return localStorage.getItem(LAST_KEY) } catch { return null }
}
function writeLast(id: string) {
  try { localStorage.setItem(LAST_KEY, id) } catch { /* private mode */ }
}

/**
 * The desktop app's Google sign-in, and which sheets Google has turned away
 * for want of it. The browser has none of this: there a sheet uses whatever
 * Google account the browser itself is signed in to.
 */
function useGoogle() {
  const [bridge] = useState(googleBridge)
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  // File ids whose frame landed on Google's sign-in page.
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set())
  // Bumped on every sign-in or sign-out, which reloads every frame with the new cookies.
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.status().then((s) => { if (live) setStatus(s) })
    const offNeeded = bridge.onNeeded((url) => {
      const fileId = signInTarget(url)
      if (fileId) setRefused((r) => new Set(r).add(fileId))
    })
    const offChanged = bridge.onChanged((s) => {
      setStatus(s)
      setRefused(new Set())
      setGeneration((g) => g + 1)
    })
    return () => { live = false; offNeeded(); offChanged() }
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

  return { bridge, status, refused, generation, forget }
}

export function Sheets({ teamId }: { teamId: string }) {
  const toast = useToast()
  const route = useRoute()
  const rows = useLiveQuery(() => sheetRepo.listForTeam(teamId), [teamId])
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const google = useGoogle()
  const [editing, setEditing] = useState<Sheet | 'new' | null>(null)
  // Sheets already opened stay loaded behind the one on screen, so flipping
  // between two is instant and each keeps its place.
  const [opened, setOpened] = useState<string[]>([])
  // Bumped to reload one sheet: a new key is a new frame.
  const [loads, setLoads] = useState<Record<string, number>>({})

  const wanted = route.params.get('sheet') ?? readLast()
  const current = rows?.find((s) => s.id === wanted) ?? rows?.[0] ?? null
  const currentRef = current ? parseSheetUrl(current.url) : null

  useEffect(() => {
    if (!current) return
    setOpened((o) => (o.includes(current.id) ? o : [...o, current.id]))
    writeLast(current.id)
  }, [current?.id])

  async function signIn() {
    if (!google.bridge) return
    const s = await google.bridge.signIn()
    toast(s.signedIn ? 'Signed in to Google' : 'Not signed in to Google', !s.signedIn)
  }

  if (rows === undefined) return null

  const needsSignIn = Boolean(google.bridge && currentRef && google.refused.has(currentRef.fileId))

  return (
    <>
      <div className="topbar">
        <h1>Sheets</h1>
        <span className="chip solid">{rows.length}</span>
        <span className="spacer" />
        {google.bridge && google.status && (google.status.signedIn
          ? (
            <>
              <span className="chip ok">Signed in to Google</span>
              <button className="btn ghost sm" onClick={async () => {
                if (!confirm('Sign this app out of Google? Private sheets will ask you to sign in again.')) return
                await google.bridge!.signOut()
                toast('Signed out of Google')
              }}>Sign out</button>
            </>
          )
          : <button className="btn" onClick={signIn}>Sign in to Google</button>)}
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
              {google.bridge
                ? 'Sheets shared with "anyone with the link" open straight away. Private ones need Sign in to Google first.'
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
                <button className="btn ghost sm" title="Load the sheet again from Google" onClick={() => {
                  google.forget(currentRef.fileId)
                  setLoads((l) => ({ ...l, [current.id]: (l[current.id] ?? 0) + 1 }))
                }}>Reload</button>
                <a className="btn ghost sm" href={browserUrl(currentRef)} target="_blank" rel="noreferrer">Open in browser</a>
                <button className="btn ghost sm" onClick={() => setEditing(current)}>Edit</button>
              </div>
            )}
          </div>

          <div className="sheet-stage">
            {rows.filter((s) => opened.includes(s.id)).map((s) => {
              const ref = parseSheetUrl(s.url)
              if (!ref) return null
              return (
                <iframe
                  key={`${s.id}:${s.url}:${loads[s.id] ?? 0}:${google.generation}`}
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
            {needsSignIn && (
              <div className="sheet-cover">
                <div className="empty">
                  <strong>Google wants you signed in</strong>
                  This sheet is not shared with "anyone with the link", so Google only shows it to an account that
                  can open it.
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
                    <button className="btn primary" onClick={signIn}>Sign in to Google</button>
                    {currentRef && <a className="btn" href={browserUrl(currentRef)} target="_blank" rel="noreferrer">Open in browser</a>}
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
