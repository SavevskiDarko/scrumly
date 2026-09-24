import { useRef, useState } from 'react'
import { useAutoSaveApi } from '../components/AutoSaveProvider'
import { useToast } from '../components/Toast'
import { LIVE_FILE, fileStore } from '../repo/fileStore'
import { FirstRunSync } from '../sync/SyncPanel'
import { formatDate } from '../lib/dates'
import { addDays, backup, nextWeekday, people as peopleRepo, settings as settingsRepo, statuses as statusRepo, teams as teamRepo } from '../repo'

const ROLES = ['Developer', 'QA', 'Tech lead', 'Designer', 'Product owner']
type Draft = { name: string; role: string }

export function FirstRun({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const auto = useAutoSaveApi()
  const fileRef = useRef<HTMLInputElement>(null)
  const [teamName, setTeamName] = useState('Team A')
  const [prefix, setPrefix] = useState('')
  const [rows, setRows] = useState<Draft[]>([{ name: '', role: 'Developer' }])
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [length, setLength] = useState(14)
  const [busy, setBusy] = useState(false)

  // The same two calls sprints.plan() makes, so the dates promised here are the
  // dates you actually get. These used to be worked out separately and the
  // preview came out two days short of every real sprint.
  const start = nextWeekday(new Date(), 1)
  const end = addDays(start, length - 1)

  function setRow(i: number, patch: Partial<Draft>) {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  }

  /** Shared tail of both restore paths: report it, and let App leave setup. */
  async function applyRestore(parsed: unknown) {
    const result = await backup.restore(parsed)
    if (!result.ok) { toast(result.error ?? 'Could not read that backup', true); setBusy(false); return }
    toast(`Restored ${result.counts?.tasks ?? 0} tasks and ${result.counts?.people ?? 0} people`)
    // The restored settings carry setupComplete, so App drops out of setup on
    // its own once the live query sees them.
    onDone()
  }

  async function restoreFromFolder() {
    setBusy(true)
    try {
      // connect(), not a bare picker: this also reconnects the autosave, so the
      // folder that saved you goes straight back to being kept current.
      const dir = await auto.connect()
      if (!dir) { setBusy(false); return }
      const parsed = await fileStore.readLive(dir)
      if (!parsed) {
        toast(`No ${LIVE_FILE} in that folder — check you picked the right one`, true)
        setBusy(false)
        return
      }
      await applyRestore(parsed)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not read that folder', true)
      setBusy(false)
    }
  }

  async function restoreFromFile(file: File) {
    setBusy(true)
    try {
      await applyRestore(JSON.parse(await file.text()))
    } catch {
      toast('That file could not be read as JSON', true)
      setBusy(false)
    }
  }

  async function finish() {
    setBusy(true)
    try {
      // ensure, not create: if setup is somehow reached twice, a second set of
      // default columns would silently double every column on the board.
      await statusRepo.ensureDefaults()
      const team = await teamRepo.create({ name: teamName, keyPrefix: prefix || undefined })
      for (const row of rows) {
        if (row.name.trim()) await peopleRepo.create({ name: row.name, role: row.role, teamIds: [team.id] })
      }
      if (paste.trim()) await peopleRepo.createFromList(paste, [team.id])
      await settingsRepo.update({
        activeTeamId: team.id,
        sprintLengthDays: length,
        setupComplete: true,
      })
      onDone()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Setup failed', true)
      setBusy(false)
    }
  }

  return (
    <div className="setup-wrap">
      <div className="setup">
        <div className="setup-card">
          <div className="brand" style={{ padding: 0, marginBottom: 16 }}>
            <span className="brand-mark">S</span>
            <span className="brand-name">Scrumly</span>
          </div>
          <h2>Set up your first team</h2>
          <p className="sub">You can change all of this later.</p>

          <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
            <div className="field" style={{ flex: 1 }}>
              <span className="label">Team name</span>
              <input className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
            </div>
            <div className="field" style={{ width: 130 }}>
              <span className="label">Task prefix</span>
              <input className="input" placeholder={teamRepo.suggestPrefix(teamName)} value={prefix}
                onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
            </div>
          </div>

          <div className="field" style={{ marginBottom: 18 }}>
            <span className="label">People</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {rows.map((row, i) => (
                <div className="person-row" key={i}>
                  <input className="input" placeholder="Name" value={row.name}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && row.name.trim() && i === rows.length - 1) {
                        setRows((r) => [...r, { name: '', role: 'Developer' }])
                      }
                    }} />
                  <select className="select" value={row.role} onChange={(e) => setRow(i, { role: e.target.value })}>
                    {ROLES.map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <button className="btn ghost sm" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                    disabled={rows.length === 1}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm" onClick={() => setRows((r) => [...r, { name: '', role: 'Developer' }])}>Add someone</button>
                <button className="btn ghost sm" onClick={() => setShowPaste((v) => !v)}>
                  {showPaste ? 'Hide paste box' : 'Paste a list instead'}
                </button>
              </div>
              {showPaste && (
                <textarea className="textarea" placeholder={'Elena, Developer\nStefan, QA\nJakim, Developer'}
                  value={paste} onChange={(e) => setPaste(e.target.value)} />
              )}
            </div>
          </div>

          <div className="field" style={{ marginBottom: 20 }}>
            <span className="label">Sprint length</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {[7, 14, 21].map((d) => (
                <button key={d} className={`chip btn-like${length === d ? ' on' : ''}`} onClick={() => setLength(d)}>
                  {d === 7 ? 'One week' : d === 14 ? 'Two weeks' : 'Three weeks'}
                </button>
              ))}
            </div>
            <span className="small faint" style={{ marginTop: 6 }}>
              Your first sprint would run {formatDate(start)} to {formatDate(end)}. You can change the length, and plan sprints, from the Sprints screen.
            </span>
          </div>

          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '9px' }}
            disabled={busy || !teamName.trim()} onClick={finish}>
            {busy ? 'Setting up…' : 'Start'}
          </button>

          {/*
            Clearing site data wipes the directory handle along with the
            database, so a returning user lands here with the app convinced it
            has never run. Without this they would have no way back to a backup
            that is sitting right there on disk.
          */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
            <p className="small" style={{ margin: '0 0 8px' }}>
              <b>Used Scrumly before?</b>
              <span className="faint"> If your browser data was cleared, your work is not lost — it is in the
                folder or the backup file you saved. Bring it back rather than starting again.</span>
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {fileStore.supported() && (
                <button className="btn sm" disabled={busy} onClick={restoreFromFolder}>Restore from a folder</button>
              )}
              <button className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                Restore from a backup file
              </button>
              <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreFromFile(f); e.target.value = '' }} />
            </div>
          </div>

          <p className="small faint" style={{ marginTop: 14, marginBottom: 0 }}>
            No account and no password. Everything is stored in this browser on this machine — which is why the first
            thing to do after adding real work is connect a folder in Settings, so this is never the only copy.
          </p>
          <FirstRunSync />
        </div>
      </div>
    </div>
  )
}
