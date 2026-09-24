import { db } from '../db/schema'
import type { Availability, ID, Kpi, KpiEntry, KpiSource, Person, Sprint, Status, StatusEvent, Task } from '../db/types'
import { newId } from './ids'
import { buildIndex, cycleTimeOf } from './insights'
import { endOfDay, eventsByTask, finishedIn, weightOf } from './sprints'

type Better = Kpi['better']

export const KPI_SOURCES: Record<KpiSource, { label: string; unit: string; better: Better; hint: string }> = {
  manual: {
    label: 'Tracked by hand', unit: '', better: 'higher',
    hint: 'You record a reading whenever you check in.',
  },
  points: {
    label: 'Points delivered per sprint', unit: 'pts', better: 'higher',
    hint: 'Points on tasks assigned to them that finished inside a sprint. Unsized tasks count as one, same as velocity.',
  },
  tasks: {
    label: 'Tasks finished per sprint', unit: 'tasks', better: 'higher',
    hint: 'Tasks assigned to them that finished inside a sprint.',
  },
  reviewed: {
    label: 'Reviews and tests per sprint', unit: 'tasks', better: 'higher',
    hint: 'Finished tasks they were the reviewer or tester on — the work an assignee count never shows.',
  },
  cycleTime: {
    label: 'Cycle time', unit: 'days', better: 'lower',
    hint: 'Median days from starting one of their tasks to finishing it, per sprint.',
  },
}

export const BOARD_SOURCES = (Object.keys(KPI_SOURCES) as KpiSource[]).filter((s) => s !== 'manual')

/** Starting points for hand-tracked KPIs. Every field stays editable. */
export const KPI_TEMPLATES: { name: string; unit: string; better: Better }[] = [
  { name: 'Review turnaround', unit: 'h', better: 'lower' },
  { name: 'Bugs escaped to production', unit: 'bugs', better: 'lower' },
  { name: 'Test coverage', unit: '%', better: 'higher' },
  { name: 'Learning time', unit: 'h', better: 'higher' },
]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function cleanTarget(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : n
}

export const kpis = {
  get: (id: ID) => db.kpis.get(id),
  forPerson: (personId: ID) => db.kpis.where('personId').equals(personId).sortBy('createdAt'),
  all: () => db.kpis.toArray(),

  entriesFor: (kpiIds: ID[]) => db.kpiEntries.where('kpiId').anyOf(kpiIds).toArray(),

  async add(input: {
    personId: ID; source?: KpiSource; name?: string; unit?: string; target?: number | null; better?: Better
  }): Promise<{ ok: boolean; reason?: string; kpi?: Kpi }> {
    const source = input.source ?? 'manual'
    const meta = KPI_SOURCES[source]
    const name = (input.name ?? (source === 'manual' ? '' : meta.label)).trim()
    if (!name) return { ok: false, reason: 'A KPI needs a name' }

    // Two of the same thing would only ever show the same numbers twice.
    const theirs = (await kpis.forPerson(input.personId)).filter((k) => k.archivedAt == null)
    if (source !== 'manual' && theirs.some((k) => k.source === source)) {
      return { ok: false, reason: `They are already measured on ${meta.label.toLowerCase()}` }
    }
    if (theirs.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, reason: `There is already a KPI called ${name}` }
    }

    const row: Kpi = {
      id: newId(),
      personId: input.personId,
      name,
      source,
      unit: (input.unit ?? meta.unit).trim(),
      target: cleanTarget(input.target),
      better: input.better ?? meta.better,
      createdAt: Date.now(),
      archivedAt: null,
    }
    await db.kpis.add(row)
    return { ok: true, kpi: row }
  },

  async update(id: ID, patch: Partial<Pick<Kpi, 'name' | 'unit' | 'target' | 'better'>>): Promise<{ ok: boolean; reason?: string }> {
    const next: Partial<Kpi> = { ...patch }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) return { ok: false, reason: 'A KPI needs a name' }
      next.name = name
    }
    if (patch.unit !== undefined) next.unit = patch.unit.trim()
    if (patch.target !== undefined) next.target = cleanTarget(patch.target)
    await db.kpis.update(id, next)
    return { ok: true }
  },

  async setArchived(id: ID, archived: boolean) {
    await db.kpis.update(id, { archivedAt: archived ? Date.now() : null })
  },

  async remove(id: ID) {
    await db.transaction('rw', db.kpis, db.kpiEntries, async () => {
      await db.kpiEntries.where('kpiId').equals(id).delete()
      await db.kpis.delete(id)
    })
  },

  /**
   * One reading per KPI per date: entering a day again corrects it rather
   * than adding a second point that makes the chart zig-zag on one day.
   */
  async record(kpiId: ID, date: string, value: number, note = ''): Promise<{ ok: boolean; reason?: string }> {
    const kpi = await db.kpis.get(kpiId)
    if (!kpi) return { ok: false, reason: 'That KPI is gone' }
    if (kpi.source !== 'manual') return { ok: false, reason: 'This one is read from the board' }
    if (!ISO_DATE.test(date)) return { ok: false, reason: 'Pick a date for the reading' }
    if (!Number.isFinite(value)) return { ok: false, reason: 'A reading needs a number' }

    await db.transaction('rw', db.kpiEntries, async () => {
      const existing = await db.kpiEntries.where('[kpiId+date]').equals([kpiId, date]).first()
      if (existing) {
        await db.kpiEntries.update(existing.id, { value, note: note.trim(), at: Date.now() })
        return
      }
      const row: KpiEntry = { id: newId(), kpiId, date, value, note: note.trim(), at: Date.now() }
      await db.kpiEntries.add(row)
    })
    return { ok: true }
  },

  removeEntry: (id: ID) => db.kpiEntries.delete(id),
}

// ---------- reading a KPI ----------

export interface KpiPoint {
  date: string
  value: number
  /** A sprint name for board KPIs; empty for hand-tracked ones, which show the date. */
  label: string
  note: string
  entryId: ID | null
}

/** Everything a board-read KPI is replayed from. */
export interface BoardHistory {
  sprints: Sprint[]
  tasks: Task[]
  statusEvents: StatusEvent[]
  statuses: Status[]
  availability: Availability[]
}

/**
 * One point per closed sprint, oldest first.
 *
 * Tasks only remember who holds them now, not who held them then, so work
 * reassigned after it finished is credited to its current owner.
 *
 * A sprint counts toward someone when they were in its team and around for it,
 * or when they finished something in it anyway. A sprint they spent entirely
 * out is skipped: zero points from someone on leave is not a missed target.
 */
export function boardSeries(source: Exclude<KpiSource, 'manual'>, person: Person, h: BoardHistory, limit = 8): KpiPoint[] {
  const ix = buildIndex(h.statuses, [], [])
  const byTask = eventsByTask(h.statusEvents)
  const theirs = source === 'reviewed'
    ? h.tasks.filter((t) => t.reviewerId === person.id || t.testerId === person.id)
    : h.tasks.filter((t) => t.assigneeId === person.id)

  const closed = h.sprints
    .filter((s) => s.state === 'closed')
    .sort((a, b) => a.endDate.localeCompare(b.endDate))

  const out: KpiPoint[] = []
  for (const sprint of closed) {
    const away = h.availability.find((a) => a.personId === person.id && a.sprintId === sprint.id)
    if (away && away.daysAvailable === 0) continue

    const done = finishedIn(sprint, theirs, byTask, ix.doneIds)
    const wasThere = person.teamIds.includes(sprint.teamId) && endOfDay(sprint.endDate) >= person.createdAt
    if (done.length === 0 && !wasThere) continue

    let value: number
    if (source === 'points') value = done.reduce((sum, t) => sum + weightOf(t), 0)
    else if (source === 'cycleTime') {
      const days = done
        .map((t) => cycleTimeOf(byTask.get(t.id) ?? [], ix))
        .filter((d): d is number => d != null)
      // Nothing finished means no cycle time, not a cycle time of zero.
      if (days.length === 0) continue
      value = Math.round(median(days) * 10) / 10
    } else value = done.length

    out.push({ date: sprint.endDate, value, label: sprint.name, note: '', entryId: null })
  }
  return out.slice(-limit)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export type KpiStatus = 'met' | 'missed' | 'none'

export function kpiStatus(kpi: Pick<Kpi, 'target' | 'better'>, value: number | null): KpiStatus {
  if (value == null || kpi.target == null) return 'none'
  const met = kpi.better === 'higher' ? value >= kpi.target : value <= kpi.target
  return met ? 'met' : 'missed'
}

export interface KpiReading {
  kpi: Kpi
  /** Oldest first. */
  series: KpiPoint[]
  latest: KpiPoint | null
  status: KpiStatus
  /** Latest minus the reading before it. */
  delta: number | null
  /** Whether that change was in the good direction. Null when flat or there is nothing to compare. */
  improved: boolean | null
}

export function readKpi(kpi: Kpi, entries: KpiEntry[], person: Person, h: BoardHistory): KpiReading {
  const series: KpiPoint[] = kpi.source === 'manual'
    ? entries
      .filter((e) => e.kpiId === kpi.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at)
      .map((e) => ({ date: e.date, value: e.value, label: '', note: e.note, entryId: e.id }))
    : boardSeries(kpi.source, person, h)

  const latest = series[series.length - 1] ?? null
  const before = series[series.length - 2] ?? null
  const delta = latest && before ? latest.value - before.value : null
  return {
    kpi,
    series,
    latest,
    status: kpiStatus(kpi, latest?.value ?? null),
    delta,
    improved: delta == null || delta === 0 ? null : (kpi.better === 'higher') === delta > 0,
  }
}

export interface KpiSummary { tracked: number; judged: number; met: number; missed: number }

/** Only KPIs with both a target and a reading can be on or off target. */
export function kpiSummary(readings: KpiReading[]): KpiSummary {
  const live = readings.filter((r) => r.kpi.archivedAt == null)
  return {
    tracked: live.length,
    judged: live.filter((r) => r.status !== 'none').length,
    met: live.filter((r) => r.status === 'met').length,
    missed: live.filter((r) => r.status === 'missed').length,
  }
}

export function formatKpiValue(value: number, unit: string): string {
  const n = value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (!unit) return n
  if (unit === '%') return `${n}%`
  // "1 task", "1 day", "1 pt" — units are written plural, and one of them reads wrong.
  const u = Math.abs(value) === 1 && /[^s]s$/.test(unit) ? unit.slice(0, -1) : unit
  return `${n} ${u}`
}
