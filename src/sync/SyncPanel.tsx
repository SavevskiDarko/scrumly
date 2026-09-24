import { useState } from 'react'
import { useToast } from '../components/Toast'
import { syncConfigured } from './config'
import { sync } from './engine'
import { useSync } from './useSync'

function ago(at: number | null): string {
  if (!at) return 'not yet'
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function SignIn({ compact }: { compact?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(await sync.signIn(email, password))
    setBusy(false)
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: compact ? undefined : 360 }}>
      <input className="input" type="email" autoComplete="username" placeholder="Email" value={email}
        onChange={(e) => setEmail(e.target.value)} />
      <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} />
      <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in and sync'}
      </button>
      {error && <span className="small" style={{ color: 'var(--alert)' }}>{error}</span>}
    </form>
  )
}

function Choose({ cloudRows }: { cloudRows: number }) {
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        This device already has data, and so does your account ({cloudRows} saved rows). Which should this device use?
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => {
          if (confirm('Replace everything on this device with the synced copy? Anything only on this device is lost — export a backup first if unsure.')) void sync.useCloud()
        }}>Use the synced copy</button>
        <button className="btn" onClick={() => {
          if (confirm('Upload this device\'s data and merge it with the synced copy? Where both have the same item, this device\'s version wins.')) void sync.useThisDevice()
        }}>Merge this device in</button>
        <button className="btn ghost" onClick={() => { void sync.signOut() }}>Cancel</button>
      </div>
    </>
  )
}

/** Settings panel: sign in, see whether this device is in step, sign out. */
export function SyncPanel() {
  const s = useSync()
  const toast = useToast()

  if (!syncConfigured()) {
    return (
      <div className="panel">
        <p className="panel-title">Sync across devices</p>
        <p className="muted" style={{ margin: 0 }}>
          Not set up in this build. Point <code>src/sync/config.ts</code> at a Supabase project to keep a laptop, tablet
          and phone on the same data — the README has the steps.
        </p>
      </div>
    )
  }

  const label: Record<string, string> = {
    starting: 'Connecting…', syncing: 'Syncing…', synced: 'In sync', offline: 'Offline — changes are kept and sent later',
    error: 'Sync failed', choose: 'Waiting for you', signedOut: 'Not signed in', off: 'Off',
  }

  return (
    <div className="panel">
      <p className="panel-title">
        Sync across devices
        <span className="spacer" />
        <span className={`chip${s.phase === 'synced' ? ' on' : s.phase === 'error' ? ' warn' : ''}`}>{label[s.phase]}</span>
      </p>

      {s.phase === 'signedOut' && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Sign in on each device with the same account and they share one set of data. Everything still works offline;
            changes are sent when there is a connection.
          </p>
          <SignIn />
        </>
      )}

      {s.phase === 'choose' && s.choice && <Choose cloudRows={s.choice.cloudRows} />}

      {s.email && s.phase !== 'choose' && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Signed in as <b>{s.email}</b> · last synced {ago(s.lastSyncedAt)}
            {s.pending > 0 && ` · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting to send`}
          </p>
          {s.error && <p className="small" style={{ color: 'var(--alert)', marginTop: 0 }}>{s.error}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => { void sync.kick() }}>Sync now</button>
            <button className="btn ghost" onClick={async () => { await sync.resync(); toast('Fetched everything again') }}>Fetch everything again</button>
            <button className="btn ghost" onClick={() => {
              if (confirm('Sign out on this device? Its data stays here, but stops syncing.')) void sync.signOut()
            }}>Sign out</button>
          </div>
          <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
            When two devices change the same item, the later save wins. Restoring a backup here replaces the data on every
            signed-in device.
          </p>
        </>
      )}
    </div>
  )
}

/** On first run: skip setup and take the data from another device instead. */
export function FirstRunSync() {
  const s = useSync()
  const [open, setOpen] = useState(false)
  if (!syncConfigured()) return null
  if (s.phase === 'syncing' || s.phase === 'starting') {
    return <p className="small faint" style={{ marginTop: 14 }}>Fetching your data…</p>
  }
  if (s.phase === 'choose' && s.choice) return <div style={{ marginTop: 14 }}><Choose cloudRows={s.choice.cloudRows} /></div>
  if (s.email) {
    return <p className="small faint" style={{ marginTop: 14 }}>Signed in as {s.email}. {s.error ?? 'Nothing synced yet — set up a team to start.'}</p>
  }
  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
      {open
        ? <SignIn compact />
        : <button className="btn ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setOpen(true)}>
            Already use Scrumly on another device? Sign in
          </button>}
    </div>
  )
}
