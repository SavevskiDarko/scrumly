import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useState } from 'react'
import { db } from '../db/schema'
import type { ID, Kpi, KpiSource } from '../db/types'
import { useKpiReadings } from '../hooks/useKpis'
import { go, setParam } from '../hooks/useRoute'
import {
  BOARD_SOURCES, KPI_SOURCES, KPI_TEMPLATES, formatKpiValue, kpiSummary, kpis as repo, notes as notesRepo,
  todayISO, type KpiReading,
} from '../repo'
import { Avatar } from './Avatar'
import { useToast } from './Toast'

function when(iso: string) {
  const d = new Date(`${iso}T12:00:00`)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })
}

/** Reads a number field the way the task size field does: blank or junk is "none". */
function numberOrNull(raw: string): number | null {
  const s = raw.trim()
  const n = Number(s)
  return s && Number.isFinite(n) ? n : null
}

const targetWord = (better: Kpi['better']) => (better === 'higher' ? 'at least' : 'at most')

function Sparkline({ reading }: { reading: KpiReading }) {
  const { series, kpi } = reading
  if (series.length < 2) return null
  const w = 300, h = 38, pad = 4
  const values = series.map((p) => p.value)
  // The target is drawn too, so it has to fit inside the scale.
  let lo = Math.min(...values, kpi.target ?? Infinity)
  let hi = Math.max(...values, kpi.target ?? -Infinity)
  if (hi === lo) { lo -= 1; hi += 1 }
  const x = (i: number) => pad + (i * (w - pad * 2)) / (series.length - 1)
  const y = (v: number) => pad + ((hi - v) * (h - pad * 2)) / (hi - lo)
  return (
    <svg className="metric-spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none"
      role="img" aria-label={`${kpi.name}: ${values.map((v) => formatKpiValue(v, kpi.unit)).join(', ')}`}>
      {kpi.target != null && (
        <line x1={pad} x2={w - pad} y1={y(kpi.target)} y2={y(kpi.target)} stroke="var(--line-strong)"
          strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      )}
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
        points={series.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
    </svg>
  )
}

function KpiCard({ reading, open, onToggle }: { reading: KpiReading; open: boolean; onToggle: () => void }) {
  const toast = useToast()
  const { kpi, series, latest, status, delta, improved } = reading
  const manual = kpi.source === 'manual'
  const retired = kpi.archivedAt != null
  const [value, setValue] = useState('')
  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')

  async function record() {
    const n = numberOrNull(value)
    if (n == null) { toast('A reading needs a number', true); return }
    const r = await repo.record(kpi.id, date, n, note)
    if (!r.ok) { toast(r.reason ?? 'Could not record that', true); return }
    setValue('')
    setNote('')
  }

  async function save(patch: Parameters<typeof repo.update>[1], el?: HTMLInputElement, revertTo?: string) {
    const r = await repo.update(kpi.id, patch)
    if (!r.ok) {
      toast(r.reason ?? 'Could not save that', true)
      if (el && revertTo !== undefined) el.value = revertTo
    }
  }

  return (
    <div className={`metric${status === 'missed' ? ' missed' : ''}${retired ? ' retired' : ''}`}>
      <div className="metric-head">
        <b className="metric-name" title={kpi.name}>{kpi.name}</b>
        {status === 'met' && <span className="chip ok">On target</span>}
        {status === 'missed' && <span className="chip warn">Off target</span>}
        {!manual && <span className="chip solid" title={KPI_SOURCES[kpi.source].hint}>from the board</span>}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onToggle} aria-expanded={open}>{open ? 'Less' : 'More'}</button>
      </div>

      <div className="metric-now">
        {latest ? (
          <>
            <span className="metric-n">{formatKpiValue(latest.value, kpi.unit)}</span>
            <span className="small faint">{latest.label || when(latest.date)}</span>
            {delta != null && delta !== 0 && (
              <span className={`small metric-delta ${improved ? 'up' : 'down'}`} title="Change since the reading before">
                {delta > 0 ? '▲' : '▼'} {formatKpiValue(Math.abs(delta), kpi.unit)}
              </span>
            )}
          </>
        ) : (
          <span className="small faint">
            {manual ? 'No readings yet.' : 'Nothing to read yet — this fills in as sprints close.'}
          </span>
        )}
        <span className="spacer" />
        {kpi.target != null && (
          <span className="small muted">Target {targetWord(kpi.better)} {formatKpiValue(kpi.target, kpi.unit)}</span>
        )}
      </div>

      <Sparkline reading={reading} />

      {manual && !retired && (
        <div className="metric-record">
          <input className="input val" type="number" step="any" placeholder={kpi.unit ? `Value (${kpi.unit})` : 'Value'}
            aria-label={`New reading for ${kpi.name}`} value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void record() }} />
          <input className="input date" type="date" aria-label="Reading date" value={date}
            onChange={(e) => setDate(e.target.value)} />
          <input className="input note" placeholder="Note (optional)" aria-label="Note" value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void record() }} />
          <button className="btn sm primary" disabled={!value.trim()} onClick={() => void record()}>Record</button>
        </div>
      )}

      {open && (
        <div className="metric-more">
          {!manual && <p className="small faint" style={{ margin: 0 }}>{KPI_SOURCES[kpi.source].hint}</p>}

          <div className="meta-grid">
            <span className="label">Name</span>
            <input className="input" key={`n-${kpi.id}-${kpi.name}`} defaultValue={kpi.name}
              onBlur={(e) => { if (e.target.value.trim() !== kpi.name) void save({ name: e.target.value }, e.target, kpi.name) }} />

            {manual && (
              <>
                <span className="label">Unit</span>
                <input className="input" key={`u-${kpi.id}-${kpi.unit}`} defaultValue={kpi.unit} placeholder="h, %, bugs — optional"
                  onBlur={(e) => { if (e.target.value.trim() !== kpi.unit) void save({ unit: e.target.value }) }} />

                <span className="label">Better when</span>
                <div className="seg sm">
                  <button className={kpi.better === 'higher' ? 'on' : ''} onClick={() => void save({ better: 'higher' })}>Higher</button>
                  <button className={kpi.better === 'lower' ? 'on' : ''} onClick={() => void save({ better: 'lower' })}>Lower</button>
                </div>
              </>
            )}

            <span className="label">Target</span>
            {/* Saves on blur, like task size: a live field would judge "1" on the way to "15". */}
            <input className="input" type="number" step="any" key={`t-${kpi.id}-${kpi.target}`} defaultValue={kpi.target ?? ''}
              placeholder={`${targetWord(kpi.better)} — optional`}
              onBlur={(e) => { const n = numberOrNull(e.target.value); if (n !== kpi.target) void save({ target: n }) }} />
          </div>

          {series.length > 0 && (
            <div>
              <p className="panel-title" style={{ marginBottom: 6 }}>
                {manual ? 'Readings' : 'Per sprint'}
                <span className="spacer" />
                <span className="faint" style={{ fontWeight: 400 }}>{series.length}</span>
              </p>
              <div className="metric-hist">
                {[...series].reverse().map((p) => (
                  <div key={p.entryId ?? `${p.label}-${p.date}`} className="metric-hist-row">
                    <span className="small faint when">{p.label || when(p.date)}</span>
                    <span className="v">{formatKpiValue(p.value, kpi.unit)}</span>
                    <span className="small muted n" title={p.note}>{p.note}</span>
                    {p.entryId && (
                      <button className="chip-x" title="Remove this reading" aria-label="Remove this reading"
                        onClick={() => void repo.removeEntry(p.entryId!)}>×</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" onClick={() => void repo.setArchived(kpi.id, !retired)}
              title={retired ? undefined : 'Hide it from the list and the summary, keeping its history'}>
              {retired ? 'Restore' : 'Retire'}
            </button>
            <button className="btn sm danger" onClick={async () => {
              const what = manual && series.length ? ` and its ${series.length} reading${series.length === 1 ? '' : 's'}` : ''
              if (!confirm(`Delete ${kpi.name}${what}? Retiring keeps the history; deleting cannot be undone.`)) return
              await repo.remove(kpi.id)
              toast(`${kpi.name} deleted`)
            }}>Delete</button>
          </div>
        </div>
      )}
    </div>
  )
}

type Choice = 'custom' | `tpl:${number}` | `board:${KpiSource}`

function presetFor(choice: Choice): { name: string; unit: string; better: Kpi['better'] } {
  if (choice.startsWith('board:')) {
    const meta = KPI_SOURCES[choice.slice(6) as KpiSource]
    return { name: meta.label, unit: meta.unit, better: meta.better }
  }
  if (choice.startsWith('tpl:')) return KPI_TEMPLATES[Number(choice.slice(4))]
  return { name: '', unit: '', better: 'higher' }
}

function AddKpi({ personId, taken, onDone }: { personId: ID; taken: Set<KpiSource>; onDone: () => void }) {
  const toast = useToast()
  const [choice, setChoice] = useState<Choice>('custom')
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('')
  const [better, setBetter] = useState<Kpi['better']>('higher')
  const [target, setTarget] = useState('')

  const source: KpiSource = choice.startsWith('board:') ? (choice.slice(6) as KpiSource) : 'manual'

  function choose(next: Choice) {
    const preset = presetFor(next)
    setChoice(next)
    setName(preset.name)
    setUnit(preset.unit)
    setBetter(preset.better)
  }

  async function add() {
    const r = await repo.add({ personId, source, name, unit, better, target: numberOrNull(target) })
    if (!r.ok || !r.kpi) { toast(r.reason ?? 'Could not add that', true); return }
    toast(`${r.kpi.name} added`)
    onDone()
  }

  return (
    <div className="dep-add">
      <div className="meta-grid">
        <span className="label">Measure</span>
        <select className="select" value={choice} onChange={(e) => choose(e.target.value as Choice)}>
          <optgroup label="Tracked by hand">
            <option value="custom">Something else…</option>
            {KPI_TEMPLATES.map((t, i) => <option key={t.name} value={`tpl:${i}`}>{t.name}</option>)}
          </optgroup>
          <optgroup label="Read from the board">
            {BOARD_SOURCES.map((s) => (
              <option key={s} value={`board:${s}`} disabled={taken.has(s)}>
                {KPI_SOURCES[s].label}{taken.has(s) ? ' — already tracked' : ''}
              </option>
            ))}
          </optgroup>
        </select>

        <span className="label">Name</span>
        <input className="input" autoFocus placeholder="What is being measured" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void add() }} />

        {source === 'manual' && (
          <>
            <span className="label">Unit</span>
            <input className="input" placeholder="h, %, bugs — optional" value={unit} onChange={(e) => setUnit(e.target.value)} />

            <span className="label">Better when</span>
            <div className="seg sm">
              <button className={better === 'higher' ? 'on' : ''} onClick={() => setBetter('higher')}>Higher</button>
              <button className={better === 'lower' ? 'on' : ''} onClick={() => setBetter('lower')}>Lower</button>
            </div>
          </>
        )}

        <span className="label">Target</span>
        <input className="input" type="number" step="any" placeholder={`${targetWord(better)} — optional`} value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void add() }} />
      </div>

      {source !== 'manual' && <p className="small faint" style={{ margin: 0 }}>{KPI_SOURCES[source].hint}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary sm" disabled={!name.trim()} onClick={() => void add()}>Add KPI</button>
        <button className="btn ghost sm" onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

export function PersonDrawer({ personId }: { personId: ID }) {
  const person = useLiveQuery(() => db.people.get(personId), [personId])
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [], [])
  const readings = useKpiReadings(person ? [person] : []).get(personId) ?? []
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<ID | null>(null)
  const [showRetired, setShowRetired] = useState(false)

  const close = useCallback(() => setParam('member', null), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  if (!person) return null

  const live = readings.filter((r) => r.kpi.archivedAt == null)
  const retired = readings.filter((r) => r.kpi.archivedAt != null)
  const sum = kpiSummary(readings)
  const taken = new Set(live.map((r) => r.kpi.source))
  const firstName = person.name.split(' ')[0]
  const teamNames = teams.filter((t) => person.teamIds.includes(t.id)).map((t) => t.name).join(', ')

  const card = (r: KpiReading) => (
    <KpiCard key={r.kpi.id} reading={r} open={openId === r.kpi.id}
      onToggle={() => setOpenId((id) => (id === r.kpi.id ? null : r.kpi.id))} />
  )

  async function oneToOne() {
    const note = await notesRepo.create({ type: 'oneToOne', personId: person!.id, title: `1:1 with ${firstName}` })
    go('notes', { note: note.id })
  }

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label={person.name}>
        <div className="drawer-head">
          <Avatar person={person} size={28} dim={!person.active} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>{person.name}</div>
            <div className="small faint">
              {person.role}{teamNames && ` · ${teamNames}`}{!person.active && ' · inactive'}
            </div>
          </div>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => void oneToOne()} title="Start a private one-to-one note">1:1 note</button>
          <button className="btn ghost sm" onClick={close}>Close</button>
        </div>

        <div className="drawer-body">
          <div>
            <p className="panel-title">
              KPIs
              <span className="spacer" />
              {sum.judged > 0 && (
                <span className="faint" style={{ fontWeight: 400, color: sum.missed ? 'var(--alert)' : undefined }}>
                  {sum.met} of {sum.judged} on target
                </span>
              )}
            </p>

            {live.length === 0 && !adding && (
              <p className="small muted" style={{ marginTop: 0 }}>
                Nothing measured yet. Agree a few KPIs with {firstName} — typed in at each check-in, or read straight
                off the board — and watch how they trend.
              </p>
            )}

            <div className="metric-list">{live.map(card)}</div>

            <div style={{ marginTop: 8 }}>
              {adding
                ? <AddKpi personId={person.id} taken={taken} onDone={() => setAdding(false)} />
                : <button className="add-row" onClick={() => setAdding(true)}>+ Add a KPI</button>}
            </div>
          </div>

          {retired.length > 0 && (
            <div>
              <button className="btn ghost sm" onClick={() => setShowRetired((v) => !v)}>
                {showRetired ? 'Hide' : 'Show'} {retired.length} retired
              </button>
              {showRetired && <div className="metric-list" style={{ marginTop: 8 }}>{retired.map(card)}</div>}
            </div>
          )}

          <p className="small faint" style={{ margin: 0 }}>
            Board KPIs are replayed from the task history, one reading per closed sprint, so they are right for sprints
            that closed before the KPI was added. They credit whoever holds a task now.
          </p>
        </div>
      </aside>
    </>
  )
}
