import { useEffect, useReducer, useState } from 'react'
import { useToast } from '../components/Toast'
import { googleBridge, type GoogleConnection } from '../desktop/bridge'

/*
 * Connecting Google, so private sheets show inside Scrumly through its API.
 * Google will not sign anyone in inside a desktop app, so consent happens in
 * the user's own browser, once, and the main process keeps the result
 * (electron/google.cjs). What it needs first is an OAuth client of the user's
 * own, which this walks them through making.
 */

let known: GoogleConnection | null = null
const listeners = new Set<() => void>()

/** Asks the main process again, and tells every screen showing it. */
export async function refreshGoogle(): Promise<void> {
  const bridge = googleBridge()
  if (!bridge) return
  known = await bridge.status()
  for (const fn of listeners) fn()
}

/** Null in the browser build, and for the moment before the first answer. */
export function useGoogleConnection(): GoogleConnection | null {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(redraw)
    if (!known) void refreshGoogle()
    return () => { listeners.delete(redraw) }
  }, [])
  return known
}

const STEPS: { text: string; link?: string; label?: string }[] = [
  { text: 'Create a project, named Scrumly for instance.', link: 'https://console.cloud.google.com/projectcreate', label: 'New project' },
  { text: 'Turn on the Google Sheets API for it: Enable.', link: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com', label: 'Sheets API' },
  {
    text: 'Get started: app name Scrumly, your Gmail as the support and contact address, Audience: External.',
    link: 'https://console.cloud.google.com/auth/overview', label: 'Google Auth Platform',
  },
  {
    text: 'Audience → Publish app, so it is In production. Left in Testing instead (with yourself as a test user), Google makes you connect again every seven days.',
    link: 'https://console.cloud.google.com/auth/audience', label: 'Audience',
  },
  {
    text: 'Clients → Create client → Application type: Desktop app → Create, then Download JSON.',
    link: 'https://console.cloud.google.com/auth/clients', label: 'Clients',
  },
]

export function GoogleConnect({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [bridge] = useState(googleBridge)
  const conn = useGoogleConnection()
  const [changing, setChanging] = useState(false)
  const [json, setJson] = useState<{ name: string; text: string } | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function close() {
    if (waiting) void bridge?.cancel()
    onClose()
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!bridge) return null

  async function connect(withClient: boolean) {
    if (!bridge) return
    setError(null)
    setWaiting(true)
    const res = await bridge.connect(withClient ? (json ? { json: json.text } : { clientId, clientSecret: secret }) : undefined)
    setWaiting(false)
    await refreshGoogle()
    if (res.ok) {
      toast(res.email ? `Connected to Google as ${res.email}` : 'Connected to Google')
      onClose()
    } else {
      setError(res.message)
    }
  }

  const settingUp = !conn?.configured || changing
  const pasted = json !== null || (clientId.trim() !== '' && secret.trim() !== '')

  let body: React.ReactNode
  if (conn && !conn.encryption) {
    body = <p className="muted">This computer cannot encrypt what Google hands over, so Scrumly will not keep it.</p>
  } else if (waiting) {
    body = (
      <>
        <p style={{ marginTop: 0 }}><b>Google's permission page is open in your browser.</b></p>
        <p className="muted">
          Choose your account, then Allow — with "See all your Google Sheets spreadsheets" ticked. Google may say it
          has not verified this app: it is your own, made a minute ago, so choose Advanced → Go to Scrumly.
        </p>
        <p className="small faint">Scrumly comes back by itself once Google answers.</p>
      </>
    )
  } else if (conn?.connected && !changing) {
    body = (
      <>
        <p style={{ marginTop: 0 }}>Connected as <b>{conn.email ?? 'your Google account'}</b>.</p>
        <p className="muted">
          Scrumly can read your Google Sheets — nothing else, and nothing in them can be changed from here. What
          Google handed over is encrypted on this computer only: not in backups, the data file, or sync.
        </p>
      </>
    )
  } else if (!settingUp) {
    body = (
      <>
        <p style={{ marginTop: 0 }}>Your Google Cloud client is in place.</p>
        <p className="muted">
          Connect opens Google's permission page in your browser. Allow it once, and private sheets show here.
          If you connected before, Google's access ran out or was taken back — connecting again fixes it.
        </p>
      </>
    )
  } else {
    body = (
      <>
        <p style={{ marginTop: 0 }} className="muted">
          Google does not let anyone sign in inside a desktop app, but it does let an app read your sheets once you
          allow it in your browser. For that, Google wants an app of your own in Google Cloud — free, about ten
          minutes, once. In <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud
          Console</a>, signed in with your Gmail:
        </p>
        <ol className="gc-steps">
          {STEPS.map((s) => (
            <li key={s.text}>
              {s.text}{' '}
              {s.link && <a href={s.link} target="_blank" rel="noreferrer">{s.label} ↗</a>}
            </li>
          ))}
        </ol>
        <div className="field" style={{ marginTop: 6 }}>
          <span className="label">The JSON you downloaded</span>
          <label className="btn" style={{ alignSelf: 'flex-start' }}>
            {json ? json.name : 'Choose the file…'}
            <input
              type="file" accept=".json,application/json" hidden
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) setJson({ name: file.name, text: await file.text() })
                setError(null)
              }}
            />
          </label>
        </div>
        {!json && (
          <div className="gc-or">
            <span className="small faint">or copy them across from the client's page</span>
            <label className="field">
              <span className="label">Client ID</span>
              <input className="input" value={clientId} placeholder="….apps.googleusercontent.com"
                onChange={(e) => { setClientId(e.target.value); setError(null) }} />
            </label>
            <label className="field">
              <span className="label">Client secret</span>
              <input className="input" type="password" value={secret} autoComplete="off"
                onChange={(e) => { setSecret(e.target.value); setError(null) }} />
            </label>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="modal" role="dialog" aria-label="Connect Google" style={{ maxWidth: 580 }}>
        <div className="modal-head">
          <b>Private sheets in Scrumly</b>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={close}>{waiting ? 'Cancel' : 'Close'}</button>
        </div>
        <div className="modal-body">
          {body}
          {error && <p className="small" style={{ color: 'var(--alert)', marginBottom: 0 }}>{error}</p>}
        </div>
        {!waiting && conn?.encryption !== false && (
          <div className="modal-foot">
            {conn?.connected && !changing && (
              <button className="btn danger" onClick={async () => {
                await bridge.disconnect()
                await refreshGoogle()
                toast('Disconnected from Google')
              }}>Disconnect</button>
            )}
            {conn?.configured && !changing && (
              <button className="btn ghost" onClick={() => { setChanging(true); setError(null) }}>Use a different client</button>
            )}
            {changing && conn?.configured && (
              <button className="btn ghost" onClick={() => { setChanging(false); setJson(null); setError(null) }}>Keep the one I have</button>
            )}
            <span className="spacer" />
            {settingUp && <button className="btn primary" disabled={!pasted} onClick={() => connect(true)}>Connect Google</button>}
            {!settingUp && !conn?.connected && <button className="btn primary" onClick={() => connect(false)}>Connect Google</button>}
          </div>
        )}
      </div>
    </>
  )
}
