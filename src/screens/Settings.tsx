import { useLiveQuery } from 'dexie-react-hooks'
import { useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import { useAutoSaveApi } from '../components/AutoSaveProvider'
import { useDesktop } from '../desktop/DesktopProvider'
import { SyncPanel } from '../sync/SyncPanel'
import { JiraPanel } from '../jira/JiraPanel'
import { fileSize, isDesktop } from '../desktop/bridge'
import { DateField } from '../components/DateField'
import { formatDate, formatDateWithWeekday } from '../lib/dates'
import { LIVE_FILE, fileStore } from '../repo/fileStore'
import {
  backup, people as peopleRepo, saveTextFile, settings as settingsRepo, statuses as statusRepo,
  teams as teamRepo, todayISO,
} from '../repo'

/** Indexed to match JavaScript's getDay(), which Sunday starts. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Blank means "no threshold"; anything not a usable number is left alone. */
function numberOrNull(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function Settings() {
  const toast = useToast()
  const auto = useAutoSaveApi()
  const desk = useDesktop()
  const onDesktop = isDesktop()
  const fileRef = useRef<HTMLInputElement>(null)
  const [newStatus, setNewStatus] = useState('')
  const [newTeam, setNewTeam] = useState('')
  const [newHoliday, setNewHoliday] = useState('')
  const [dump, setDump] = useState<string | null>(null)
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(
    () => (document.documentElement.getAttribute('data-theme') as 'light' | 'dark' | null) ?? 'system',
  )

  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const counts = useLiveQuery(async () => ({
    tasks: await db.tasks.count(),
    people: await db.people.count(),
    events: await db.statusEvents.count(),
  }), [], { tasks: 0, people: 0, events: 0 })
  const teamStats = useLiveQuery(async () => {
    const out: Record<string, { tasks: number; members: number; sprints: number }> = {}
    for (const t of await db.teams.toArray()) {
      out[t.id] = {
        tasks: await db.tasks.where('teamId').equals(t.id).count(),
        members: (await peopleRepo.listForTeam(t.id)).length,
        sprints: await db.sprints.where('teamId').equals(t.id).count(),
      }
    }
    return out
  }, [], {} as Record<string, { tasks: number; members: number; sprints: number }>)

  const team = teams.find((t) => t.id === cfg?.activeTeamId) ?? teams[0]
  // Kept on this computer only: never in the data file, a backup, or sync.
  const keptHere = teams.filter((t) => t.localOnly)
  const keptNames = keptHere.map((t) => t.name).join(', ')
  const keptVerb = keptHere.length === 1 ? 'is' : 'are'
  const keptNote = keptHere.length
    ? `\n\n${keptNames} ${keptVerb} left as ${keptHere.length === 1 ? 'it is' : 'they are'}: kept on this computer only, and never in a backup.`
    : ''
  // Past holidays still count — they are what keeps old sprints' capacity
  // honest — but nobody needs to see last year's list every time.
  const holidays = cfg?.holidays ?? []
  const upcoming = holidays.filter((d) => d >= todayISO())
  const pastHolidays = holidays.length - upcoming.length

  async function doExport() {
    const snap = await backup.snapshot()
    const text = JSON.stringify(snap, null, 2)
    const ok = await saveTextFile(backup.filename(), text)
    if (ok) {
      await settingsRepo.update({ lastBackupAt: Date.now() })
      toast('Backup saved')
    } else {
      setDump(text)
      toast('Could not save a file here — copy the text instead', true)
    }
  }

  /** Same guarded path as importing a file, but read straight from the folder. */
  async function restoreFromFolder() {
    const dir = await fileStore.saved()
    if (!dir) { toast('No folder connected', true); return }
    if ((await fileStore.permission(dir, true)) !== 'granted') {
      toast('Scrumly needs permission to read that folder', true)
      return
    }
    const parsed = await fileStore.readLive(dir)
    if (!parsed) { toast(`No ${LIVE_FILE} in that folder yet`, true); return }
    const ok = confirm(
      `Restore from the folder copy?\n\nThis replaces everything currently in Scrumly — ${counts.tasks} tasks, ` +
      `${counts.people} people and ${counts.events} recorded moves — and cannot be undone.${keptNote}`,
    )
    if (!ok) return
    const result = await backup.restore(parsed)
    toast(result.ok
      ? `Restored ${result.counts?.tasks ?? 0} tasks and ${result.counts?.people ?? 0} people`
      : result.error ?? 'Could not restore that file', !result.ok)
  }

  /**
   * The desktop app loads this file for you at startup when the database is
   * empty. This button is the other direction — the file is known-good and
   * what is loaded is not — so it asks with the same real numbers as a restore.
   */
  async function loadFromDataFile() {
    const ok = confirm(
      'Load everything from the data file?\n\n' +
      `This replaces what is currently open — ${counts.tasks} tasks, ${counts.people} people and ` +
      `${counts.events} recorded moves — and cannot be undone.`,
    )
    if (!ok) return
    const result = await desk.loadFromFile()
    toast(result.ok
      ? `Loaded ${result.counts?.tasks ?? 0} tasks and ${result.counts?.people ?? 0} people`
      : result.error ?? 'Could not read the data file', !result.ok)
  }

  async function doImport(file: File) {
    try {
      const parsed = JSON.parse(await file.text())
      // Restore clears every table first. It is the most destructive thing in
      // the app, so it asks with the real numbers rather than a generic warning.
      const ok = confirm(
        `Restore from ${file.name}?\n\n` +
        `This replaces everything currently in Scrumly — ${counts.tasks} tasks, ` +
        `${counts.people} people and ${counts.events} recorded moves — and cannot be undone.${keptNote}`,
      )
      if (!ok) return
      const result = await backup.restore(parsed)
      if (!result.ok) { toast(result.error ?? 'Could not restore that file', true); return }
      toast(`Restored ${result.counts?.tasks ?? 0} tasks and ${result.counts?.people ?? 0} people`)
    } catch {
      toast('That file could not be read as JSON', true)
    }
  }

  return (
    <>
      <div className="topbar"><h1>Settings</h1></div>
      <div className="screen pad" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>

        <div className="panel">
          <p className="panel-title">
            Teams
            <span className="spacer" />
            <span className="faint" style={{ fontWeight: 400 }}>{teams.length}</span>
          </p>
          <div className="row-head" style={{ background: 'none', padding: '0 0 8px' }}>
            <span style={{ flex: 1 }}>Name</span>
            <span style={{ width: 110 }}>Key prefix</span>
            <span style={{ width: 150 }}>Holds</span>
            <span style={{ width: 130 }} />
          </div>
          {teams.map((t) => {
            const stat = teamStats[t.id] ?? { tasks: 0, members: 0, sprints: 0 }
            return (
              <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line)' }}>
                <input className="inline-input" style={{ flex: 1, fontWeight: t.id === team?.id ? 600 : 400 }}
                  defaultValue={t.name} onBlur={(e) => teamRepo.update(t.id, { name: e.target.value })} />
                {t.localOnly && (
                  <span className="chip" title="Not synced, exported in backups or written to the data folder. Change it under Jira.">
                    this computer only
                  </span>
                )}
                <input className="input" style={{ width: 110 }} defaultValue={t.keyPrefix}
                  onBlur={(e) => teamRepo.update(t.id, { keyPrefix: e.target.value })} />
                <span style={{ width: 150 }} className="small faint">
                  {stat.members} people · {stat.tasks} tasks{stat.sprints ? ` · ${stat.sprints} sprints` : ''}
                </span>
                <div style={{ width: 130, display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                  {t.id === team?.id
                    ? <span className="chip on">active</span>
                    : <button className="btn sm" onClick={() => settingsRepo.setActiveTeam(t.id)}>Switch to</button>}
                  <button className="btn ghost sm" title={`Remove ${t.name}`} onClick={async () => {
                    // Removing a team also drops every member's place in it and
                    // deletes its stand-up history, so it asks first.
                    if (!confirm(`Remove ${t.name}? Its ${stat.members} member${stat.members === 1 ? '' : 's'} stay, but lose their place in it, and its stand-up history goes with it.`)) return
                    const r = await teamRepo.remove(t.id)
                    if (!r.ok) toast(r.reason ?? 'Cannot remove that team', true)
                    else toast(`${t.name} removed`)
                  }}>×</button>
                </div>
              </div>
            )
          })}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input className="input" style={{ maxWidth: 220 }} placeholder="New team name" value={newTeam}
              onChange={(e) => setNewTeam(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && newTeam.trim()) { await teamRepo.create({ name: newTeam }); setNewTeam('') }
              }} />
            <button className="btn" disabled={!newTeam.trim()} onClick={async () => {
              const t = await teamRepo.create({ name: newTeam }); setNewTeam('')
              toast(`${t.name} created — add people to it from the People screen`)
            }}>Add team</button>
          </div>
          <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
            Each team gets its own board, sprints and task numbering. Columns below are shared across all of them, since
            the workflow is usually yours rather than theirs. A team holding tasks or sprints cannot be deleted.
          </p>
        </div>

        <div className="panel">
          <p className="panel-title">Sprints</p>
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div className="field">
              <span className="label">Length</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {[7, 14, 21].map((d) => (
                  <button key={d} className={`chip btn-like${cfg?.sprintLengthDays === d ? ' on' : ''}`}
                    onClick={() => settingsRepo.update({ sprintLengthDays: d })}>
                    {d === 7 ? 'One week' : d === 14 ? 'Two weeks' : 'Three weeks'}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="label">Starts on</span>
              <select className="select" style={{ width: 130 }} value={cfg?.sprintStartWeekday ?? 1}
                onChange={(e) => settingsRepo.update({ sprintStartWeekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
          </div>
          <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
            Used when you plan a sprint with no dates set. Sprints after the first start three days after the
            previous one ends, so this only decides where the very first one lands. Changing it leaves sprints
            that already exist alone.
          </p>

          <div className="field" style={{ marginTop: 16 }}>
            <span className="label">Holidays</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {upcoming.map((d) => (
                <span key={d} className="chip">
                  {formatDateWithWeekday(d)}
                  <button className="chip-x" title="Remove" onClick={() => void settingsRepo.removeHoliday(d)}>×</button>
                </span>
              ))}
              {upcoming.length === 0 && <span className="small faint">None coming up.</span>}
              {pastHolidays > 0 && <span className="small faint">and {pastHolidays} past</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <DateField value={newHoliday || null} clearable label="Holiday" style={{ width: 160 }}
                onCommit={(iso) => setNewHoliday(iso ?? '')} />
              <button className="btn" disabled={!newHoliday} onClick={async () => {
                await settingsRepo.addHoliday(newHoliday)
                setNewHoliday('')
              }}>Add holiday</button>
            </div>
          </div>
          <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
            Days nobody works. They come out of every sprint's working days, so the burndown does not expect work on
            them and sprint planning does not count them as capacity. Individual leave goes on the planning screen instead.
          </p>
        </div>

        <div className="panel">
          <p className="panel-title">Columns</p>
          <div className="row-head" style={{ background: 'none', padding: '0 0 8px' }}>
            <span style={{ flex: 1 }}>Name</span>
            <span style={{ width: 104 }}>Counts as active</span>
            <span style={{ width: 84 }}>Stuck after</span>
            <span style={{ width: 76 }}>WIP limit</span>
            <span style={{ width: 96 }} />
          </div>
          {statuses.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--line)' }}>
              <input className="inline-input" style={{ flex: 1 }} defaultValue={s.name}
                onBlur={(e) => e.target.value.trim() && statusRepo.update(s.id, { name: e.target.value.trim() })} />
              <label style={{ width: 104, display: 'flex', alignItems: 'center', gap: 7 }}>
                <input type="checkbox" checked={s.countsAsActive} onChange={(e) => statusRepo.update(s.id, { countsAsActive: e.target.checked })} />
                <span className="small faint">{s.countsAsActive ? 'yes' : 'no'}</span>
              </label>
              {/* On blur, not on change: typing "10" through a live field wrote 1
                  first, and for a day threshold that briefly marks every card stuck. */}
              <input className="input" style={{ width: 84 }} type="number" min={0} placeholder="—"
                key={`stuck-${s.id}`} defaultValue={s.stuckAfterDays ?? ''}
                onBlur={(e) => statusRepo.update(s.id, { stuckAfterDays: numberOrNull(e.target.value) })} />
              <input className="input" style={{ width: 76 }} type="number" min={0} placeholder="—"
                key={`wip-${s.id}`} defaultValue={s.wipLimit ?? ''}
                onBlur={(e) => statusRepo.update(s.id, { wipLimit: numberOrNull(e.target.value) })} />
              <div style={{ width: 96, display: 'flex', gap: 3, justifyContent: 'flex-end' }}>
                <button className="btn ghost sm" disabled={i === 0} onClick={() => statusRepo.reorder(s.id, -1)}>↑</button>
                <button className="btn ghost sm" disabled={i === statuses.length - 1} onClick={() => statusRepo.reorder(s.id, 1)}>↓</button>
                <button className="btn ghost sm" onClick={async () => {
                  const r = await statusRepo.remove(s.id)
                  if (!r.ok) toast(r.reason ?? 'Cannot remove that column', true)
                }}>×</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input className="input" style={{ maxWidth: 220 }} placeholder="New column name" value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newStatus.trim()) { void statusRepo.add(newStatus.trim()); setNewStatus('') } }} />
            <button className="btn" disabled={!newStatus.trim()} onClick={() => { void statusRepo.add(newStatus.trim()); setNewStatus('') }}>Add column</button>
          </div>
          <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
            A column with tasks in it cannot be deleted. Blocked is deliberately not a column — it arrives in slice 2 as a flag that keeps the task where the work really is.
          </p>
        </div>

        {onDesktop && (
          <div className="panel">
            <p className="panel-title">
              Data file
              <span className="spacer" />
              <span className={`chip${desk.status.state === 'held' || desk.status.state === 'failed' ? ' warn' : ' on'}`}>
                {desk.status.state === 'saving' ? 'saving'
                  : desk.status.state === 'held' ? 'writing paused'
                    : desk.status.state === 'failed' ? 'failed' : 'on'}
              </span>
            </p>

            <p className="muted" style={{ marginTop: 0 }}>
              Everything is kept in a plain JSON file, rewritten a couple of seconds after anything changes, plus one
              dated snapshot a day under <code>history/</code>. Scrumly reads it back by itself when it starts with an
              empty database, so reinstalling the app, or moving to another machine with this folder, costs you nothing.
            </p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="chip solid" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {desk.status.info?.file ?? 'locating…'}
              </span>
              <span className="small faint">
                {desk.status.info?.exists
                  ? `${fileSize(desk.status.info.bytes)}${desk.status.lastSavedAt ? ` · saved ${new Date(desk.status.lastSavedAt).toLocaleTimeString()}` : ''}`
                  : 'nothing written yet'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <button className="btn sm" onClick={() => void desk.saveNow()}>Save now</button>
              <button className="btn sm" onClick={() => void desk.reveal()}>Open folder</button>
              <button className="btn sm" onClick={() => void desk.chooseFolder()}>Change folder…</button>
              <button className="btn sm" onClick={loadFromDataFile}>Load from file</button>
            </div>

            {keptHere.length > 0 && (
              <p className="small faint" style={{ marginBottom: 0, marginTop: 10 }}>
                {keptNames} {keptVerb} kept on this computer only, so not in this file. {keptHere.length === 1 ? 'It is' : 'They are'} saved
                in <code>{desk.status.info?.localDir ?? 'a folder of its own'}</code> instead, which never moves.
              </p>
            )}

            {desk.status.error && (
              <p className="small" style={{ color: 'var(--alert)', marginBottom: 0, marginTop: 10 }}>
                {desk.status.error}
                {desk.status.state === 'held' && ' Nothing is being written until this is sorted, so the file on disk is still intact.'}
              </p>
            )}

            <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
              Point this at a folder inside OneDrive, Dropbox or a git repository and you get off-machine backup and
              version history for free. If the database already has work in it when Scrumly starts, that wins and the
              file is brought up to date behind it — use <b>Load from file</b> to go the other way deliberately.
            </p>
          </div>
        )}

        {/* The browser's folder mirror and the desktop data file do the same
            job by different means. Running both would mean two writers for one
            set of data, so only the one that applies is offered. */}
        {!onDesktop && (
        <div className="panel">
          <p className="panel-title">
            Local folder
            <span className="spacer" />
            {auto.status.folder && (
              <span className={`chip${auto.status.state === 'blocked' || auto.status.state === 'failed' ? ' warn' : ' on'}`}>
                {auto.status.state === 'saving' ? 'saving' : auto.status.state === 'blocked' ? 'needs permission'
                  : auto.status.state === 'failed' ? 'failed' : 'on'}
              </span>
            )}
          </p>

          {!fileStore.supported() ? (
            <p className="muted" style={{ marginTop: 0 }}>
              This browser cannot write to a folder — the File System Access API is Chrome and Edge only. Use Scrumly
              there if you want automatic copies, or keep exporting a backup by hand below. Nothing else differs.
            </p>
          ) : !auto.status.folder ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Pick a folder and Scrumly keeps a plain JSON copy of everything in it, rewritten a few seconds after
                anything changes, plus one dated snapshot a day. Choose one inside OneDrive, Dropbox or a git repo and
                clearing site data stops being the end of your data.
              </p>
              <button className="btn primary" onClick={() => void auto.connect()}>Choose a folder</button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="chip solid">{auto.status.folder}</span>
                <span className="small faint">
                  {auto.status.lastSavedAt
                    ? `saved ${new Date(auto.status.lastSavedAt).toLocaleTimeString()}`
                    : 'nothing written yet'}
                </span>
                <span className="spacer" />
                {auto.status.state === 'blocked' && (
                  <button className="btn primary sm" onClick={() => void auto.reconnect()}>Grant access again</button>
                )}
                <button className="btn sm" onClick={() => void auto.saveNow()}>Save now</button>
                <button className="btn sm" onClick={restoreFromFolder}>Restore from it</button>
                <button className="btn ghost sm" onClick={async () => {
                  if (!confirm('Stop copying to that folder? The files already written stay where they are.')) return
                  await auto.disconnect()
                  toast('Folder disconnected')
                }}>Disconnect</button>
              </div>
              {auto.status.error && (
                <p className="small" style={{ color: 'var(--alert)', marginBottom: 0 }}>{auto.status.error}</p>
              )}
              <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
                Permission does not survive a browser restart on its own, so Scrumly asks again the first time you open
                it. Until you grant it, nothing is written — the badge above says so rather than failing quietly.
              </p>
            </>
          )}
        </div>
        )}

        <SyncPanel />

        <JiraPanel />

        <div className="panel">
          <p className="panel-title">Backup</p>
          <p className="muted" style={{ marginTop: 0 }}>
            {onDesktop
              ? 'The data file above is already a copy you can read without Scrumly. An export is the same JSON, saved wherever you point it — worth one before anything drastic.'
              : 'Everything lives in this browser on this machine. A backup is plain JSON you can read without Scrumly, and it is the only copy that exists anywhere else.'}
            {keptHere.length > 0 && ` It leaves out ${keptNames}, which ${keptVerb} kept on this computer only.`}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn primary" onClick={doExport}>Export a backup</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>Restore from a file</button>
            <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = '' }} />
            <span className="small faint">
              {counts.tasks} tasks · {counts.people} people · {counts.events} recorded moves
              {cfg?.lastBackupAt ? ` · last backup ${formatDate(cfg.lastBackupAt)}` : ' · never backed up'}
            </span>
          </div>
          {dump && (
            <div className="field" style={{ marginTop: 12 }}>
              <span className="label">Copy this and save it somewhere</span>
              <textarea className="textarea" style={{ minHeight: 140, fontFamily: 'ui-monospace, monospace', fontSize: 11 }} readOnly value={dump} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDump(null)}>Hide</button>
            </div>
          )}
          <p className="small" style={{ color: 'var(--alert)', marginTop: 12, marginBottom: 0 }}>
            Restoring replaces everything currently in the app. Export first if you are not certain.
          </p>
        </div>

        <div className="panel">
          <p className="panel-title">Appearance</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['system', 'light', 'dark'] as const).map((mode) => (
              <button key={mode} className={`btn${theme === mode ? ' primary' : ''}`} onClick={() => {
                if (mode === 'system') document.documentElement.removeAttribute('data-theme')
                else document.documentElement.setAttribute('data-theme', mode)
                try { localStorage.setItem('scrumly-theme', mode) } catch { /* private mode */ }
                setTheme(mode)
              }}>{mode[0].toUpperCase() + mode.slice(1)}</button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
