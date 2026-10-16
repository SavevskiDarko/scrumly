import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import { teams as teamRepo } from '../repo'
import { useAssistant } from './AssistantProvider'

const KEYS_PAGE = 'https://console.anthropic.com/settings/keys'

function Connect({ onDone }: { onDone: () => Promise<void> }) {
  const { bridge } = useAssistant()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const r = await bridge!.connect({ apiKey })
    setBusy(false)
    if (!r.ok) { setError(r.message); return }
    setApiKey('')
    await onDone()
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
      <input className="input" type="password" placeholder="Anthropic API key (sk-ant-…)" value={apiKey}
        onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy || !apiKey.trim()}>{busy ? 'Checking with Anthropic…' : 'Connect'}</button>
        {error && <span className="small" style={{ color: 'var(--alert)' }}>{error}</span>}
      </div>
      <p className="small faint" style={{ margin: 0 }}>
        Make a key in the <a href={KEYS_PAGE} target="_blank" rel="noreferrer">Claude Console → API keys</a>. What the
        assistant uses is billed to that Anthropic account. The key is encrypted by Windows and stays on this computer — it
        is never synced, backed up or saved with your data.
      </p>
    </form>
  )
}

export function AssistantSettings() {
  const toast = useToast()
  const { bridge, connection, refresh, conversation, setOpen } = useAssistant()
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const kept = teams.filter((t) => t.localOnly)

  if (!bridge) {
    return (
      <div className="panel">
        <p className="panel-title">Assistant</p>
        <p className="muted" style={{ margin: 0 }}>
          The assistant — Claude, helping with your day and your sprints — runs in the Scrumly desktop app, where its
          Anthropic API key can be kept encrypted on your computer.
        </p>
      </div>
    )
  }

  return (
    <div className="panel">
      <p className="panel-title">
        Assistant
        <span className="spacer" />
        {connection?.connected && <span className="chip on">connected</span>}
      </p>

      {!connection ? (
        <p className="small faint" style={{ margin: 0 }}>Checking…</p>
      ) : !connection.encryption ? (
        <p className="small" style={{ color: 'var(--alert)', margin: 0 }}>
          This computer cannot encrypt a stored key, so Scrumly will not keep one. The assistant is unavailable here.
        </p>
      ) : !connection.connected ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Claude, from Anthropic, inside Scrumly: ask what to focus on today, how the sprint is going, who to chase, or
            for help with planning and retros. Connect an API key to turn it on.
          </p>
          <Connect onDone={async () => { await refresh(); toast('Assistant connected — Ctrl+J opens it'); setOpen(true) }} />
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted">Claude Opus 5.5, with your Anthropic API key.</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => setOpen(true)}>Open (Ctrl+J)</button>
          <button className="btn ghost sm" onClick={async () => {
            if (!confirm('Disconnect the assistant? Scrumly forgets the API key; you can connect again any time.')) return
            conversation?.reset()
            await bridge.disconnect()
            await refresh()
            toast('Assistant disconnected')
          }}>Disconnect</button>
        </div>
      )}

      <p className="small faint" style={{ marginTop: 12, marginBottom: 0 }}>
        Each question goes to Anthropic together with the open team's board, sprints, blockers, recent stand-up notes and
        your follow-ups — and whatever else the assistant looks up to answer it. Notes marked private are never sent. It
        can propose changes, but nothing in Scrumly changes until you click Apply.
      </p>

      {kept.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <p className="label" style={{ margin: '0 0 6px' }}>Teams kept on this computer only</p>
          <p className="small faint" style={{ margin: '0 0 8px' }}>
            Hidden from the assistant unless you allow it: whatever it reads is sent to Anthropic, which is what keeping a
            team here is meant to prevent. Allow one only if that is acceptable for its board.
          </p>
          {kept.map((t) => (
            <label key={t.id} className="jira-check" style={{ padding: '3px 0' }}>
              <input type="checkbox" checked={t.assistant === true} onChange={async (e) => {
                await teamRepo.setAssistant(t.id, e.target.checked)
                toast(e.target.checked ? `The assistant can now read ${t.name}` : `${t.name} is hidden from the assistant again`)
              }} />
              Let the assistant read <b>{t.name}</b>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
