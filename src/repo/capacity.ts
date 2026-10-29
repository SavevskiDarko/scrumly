import { db } from '../db/schema'
import type { Availability, CapacityHours, CapacityItem, ID, Person, Sprint, Task, TeamCapacity } from '../db/types'
import { newId } from './ids'
import { availability } from './planning'
import { settings } from './settings'
import { workingDays } from './sprints'

/*
 * Team capacity: a sprint's hours, person by person, the way teams keep them in
 * a spreadsheet. Working hours, less leave and the time that goes to overhead,
 * is what each person has for sprint work. Less what is already booked against
 * named tickets, it is what they can still take on.
 *
 * Leave is not stored here. It is the availability Sprint planning already
 * reads, in hours instead of days, so the forecast there and the hours here
 * never disagree about who is out.
 */

export interface CapacityRates {
  hoursPerDay: number
  othersPerDay: number
  overheadPerDay: number
}

/** An eight-hour day, half an hour of it to "Others" and two to overhead: the spreadsheet this replaces. */
export const DEFAULT_RATES: CapacityRates = { hoursPerDay: 8, othersPerDay: 0.5, overheadPerDay: 2 }

export type CapacityField = keyof CapacityHours

type Result = { ok: true } | { ok: false; reason: string }

/** Two decimals: enough for quarter hours, and no 0.30000000000000004 in a cell. */
const r2 = (n: number) => Math.round(n * 100) / 100

const ratesOf = (s: CapacityRates): CapacityRates =>
  ({ hoursPerDay: s.hoursPerDay, othersPerDay: s.othersPerDay, overheadPerDay: s.overheadPerDay })

const sheetFor = (sprintId: ID) => db.teamCapacity.where('sprintId').equals(sprintId).first()

/** What a new sheet starts from: the team's last one, so a team on 7.5-hour days only says so once. */
async function startingRates(teamId: ID): Promise<CapacityRates> {
  const last = (await db.teamCapacity.where('teamId').equals(teamId).sortBy('updatedAt')).at(-1)
  return last ? ratesOf(last) : { ...DEFAULT_RATES }
}

/** Hours typed in: nothing negative, nothing that is not a number. Null and zero both mean "none". */
function cleanHours(hours: number | null): number | null | 'bad' {
  if (hours == null) return null
  if (!Number.isFinite(hours) || hours < 0) return 'bad'
  return hours === 0 ? null : r2(hours)
}

/**
 * Changes one sprint's sheet, making it first if nothing has been typed into
 * it yet. `fn` edits the copy it is handed, or returns why it will not.
 */
async function edit(sprintId: ID, fn: (sheet: TeamCapacity, sprint: Sprint) => string | void): Promise<Result> {
  return db.transaction('rw', db.teamCapacity, db.sprints, async () => {
    const sprint = await db.sprints.get(sprintId)
    if (!sprint) return { ok: false as const, reason: 'That sprint is gone' }
    const found = await sheetFor(sprintId)
    const sheet: TeamCapacity = found
      ? structuredClone(found)
      : {
        id: newId(), teamId: sprint.teamId, sprintId, ...(await startingRates(sprint.teamId)),
        people: {}, items: [], updatedAt: 0,
      }
    const refused = fn(sheet, sprint)
    if (refused) return { ok: false as const, reason: refused }
    sheet.updatedAt = Date.now()
    await db.teamCapacity.put(sheet)
    return { ok: true as const }
  })
}

export const capacity = {
  forSprint: async (sprintId: ID): Promise<TeamCapacity | null> => (await sheetFor(sprintId)) ?? null,

  /** The stored sheet, if there is one, and the rates it has or a new one would start with. */
  async read(teamId: ID, sprintId: ID): Promise<{ sheet: TeamCapacity | null; rates: CapacityRates }> {
    const sheet = (await sheetFor(sprintId)) ?? null
    return { sheet, rates: sheet ? ratesOf(sheet) : await startingRates(teamId) }
  },

  setRates: (sprintId: ID, patch: Partial<CapacityRates>) => edit(sprintId, (sheet) => {
    const next = { ...ratesOf(sheet), ...patch }
    if (!Number.isFinite(next.hoursPerDay) || next.hoursPerDay <= 0 || next.hoursPerDay > 24) {
      return 'A working day is between 0 and 24 hours'
    }
    if (![next.othersPerDay, next.overheadPerDay].every((n) => Number.isFinite(n) && n >= 0)) {
      return 'Hours a day cannot be negative'
    }
    if (next.othersPerDay + next.overheadPerDay > next.hoursPerDay) {
      return 'Others and OH together are more than the whole day'
    }
    Object.assign(sheet, { hoursPerDay: r2(next.hoursPerDay), othersPerDay: r2(next.othersPerDay), overheadPerDay: r2(next.overheadPerDay) })
  }),

  /** Unknown, or Others and OH typed over what is worked out. Null clears it back. */
  setHours: (sprintId: ID, personId: ID, field: CapacityField, hours: number | null) => edit(sprintId, (sheet) => {
    const clean = cleanHours(hours)
    if (clean === 'bad') return 'Hours are a number, zero or more'
    const mine = { ...sheet.people[personId] }
    // Zero typed over Others is a real answer ("none this sprint"), not a blank.
    const keep = field === 'unknown' ? clean : hours == null ? null : r2(hours)
    if (keep == null) delete mine[field]
    else mine[field] = keep
    if (Object.keys(mine).length) sheet.people[personId] = mine
    else delete sheet.people[personId]
  }),

  /**
   * Vacation, in hours, written as the days Sprint planning reads. Those are
   * kept in half days, so hours are too: 3 hours off reads back as half a day.
   */
  async setVacation(sprintId: ID, personId: ID, hours: number | null): Promise<Result> {
    const sprint = await db.sprints.get(sprintId)
    if (!sprint) return { ok: false, reason: 'That sprint is gone' }
    const clean = cleanHours(hours)
    if (clean === 'bad') return { ok: false, reason: 'Hours are a number, zero or more' }
    const { rates } = await capacity.read(sprint.teamId, sprintId)
    const wd = workingDays(sprint.startDate, sprint.endDate, (await settings.get()).holidays).length
    await availability.set(personId, sprintId, clean == null ? null : Math.max(0, wd - clean / rates.hoursPerDay))
    return { ok: true }
  },

  /**
   * A column to book hours against. A team task's key links it to that task;
   * anything else — another project's ticket, "Support" — is kept as typed.
   */
  async addItem(sprintId: ID, text: string): Promise<Result & { item?: CapacityItem }> {
    const typed = text.trim()
    if (!typed) return { ok: false, reason: 'Type a task key or a name for the work' }
    const sprint = await db.sprints.get(sprintId)
    if (!sprint) return { ok: false, reason: 'That sprint is gone' }
    const task = await db.tasks.where('key').equalsIgnoreCase(typed).filter((t) => t.teamId === sprint.teamId).first()
    const item: CapacityItem = { id: newId(), taskId: task?.id ?? null, label: task?.key ?? typed, hours: {} }
    const done = await edit(sprintId, (sheet) => {
      const same = sheet.items.find((i) => (task && i.taskId === task.id) || i.label.toLowerCase() === item.label.toLowerCase())
      if (same) return `${same.label} is already on the sheet`
      sheet.items.push(item)
    })
    return done.ok ? { ok: true, item } : done
  },

  /** Every task in the sprint that is not on the sheet yet, in key order. Returns how many were added. */
  async addSprintTasks(sprintId: ID): Promise<number> {
    const inSprint = (await db.tasks.where('sprintId').equals(sprintId).toArray())
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
    let added = 0
    await edit(sprintId, (sheet) => {
      const have = new Set(sheet.items.map((i) => i.taskId))
      for (const t of inSprint) {
        if (have.has(t.id)) continue
        sheet.items.push({ id: newId(), taskId: t.id, label: t.key, hours: {} })
        added++
      }
      if (!added) return 'Nothing to add'
    })
    return added
  },

  /** Hours one person has booked on one column. Null or zero takes them off it. */
  book: (sprintId: ID, itemId: ID, personId: ID, hours: number | null) => edit(sprintId, (sheet) => {
    const clean = cleanHours(hours)
    if (clean === 'bad') return 'Hours are a number, zero or more'
    const item = sheet.items.find((i) => i.id === itemId)
    if (!item) return 'That column is gone'
    if (clean == null) delete item.hours[personId]
    else item.hours[personId] = clean
  }),

  removeItem: (sprintId: ID, itemId: ID) => edit(sprintId, (sheet) => {
    sheet.items = sheet.items.filter((i) => i.id !== itemId)
  }),
}

/** Everyone the sheet has hours for, so someone who has left the team still shows on the sprints they worked. */
export function capacityPeopleIds(sheet: TeamCapacity | null): ID[] {
  if (!sheet) return []
  const ids = new Set(Object.keys(sheet.people))
  for (const item of sheet.items) for (const id of Object.keys(item.hours)) ids.add(id)
  return [...ids]
}

export interface CapacityLine {
  person: Person
  /** False for someone with hours in this sprint who is no longer in the team. */
  member: boolean
  /** Every working day, in hours. */
  working: number
  unknown: number
  vacation: number
  others: number
  othersTyped: boolean
  overhead: number
  overheadTyped: boolean
  /** What is left for sprint work once leave and overhead are out. */
  capacity: number
  booked: number
  /** What they can still take on. Below zero when booked past their hours. */
  left: number
}

export interface CapacityColumn {
  item: CapacityItem
  /** Null for work that is not a task here, or a task since deleted. */
  task: Task | null
  total: number
}

export interface CapacitySheet {
  workingDays: number
  rates: CapacityRates
  lines: CapacityLine[]
  columns: CapacityColumn[]
  totals: Pick<CapacityLine, 'working' | 'unknown' | 'vacation' | 'others' | 'overhead' | 'capacity' | 'booked' | 'left'>
}

/**
 * The spreadsheet's arithmetic. Total capacity is working hours less unknown,
 * vacation, others and OH; what is left is that less every hour booked. Others
 * and OH are so many hours for each day someone is actually in, so a week off
 * takes them down too — unless a number was typed over them.
 */
export function capacitySheet(input: {
  sprint: Sprint
  members: Person[]
  /** Anyone else the sheet has hours for: people who have since left the team. */
  former?: Person[]
  sheet: TeamCapacity | null
  rates: CapacityRates
  availability: Availability[]
  tasks: Task[]
  holidays?: readonly string[]
}): CapacitySheet {
  const { sprint, sheet } = input
  const rates = sheet ? ratesOf(sheet) : input.rates
  const wd = workingDays(sprint.startDate, sprint.endDate, input.holidays ?? []).length
  const items = sheet?.items ?? []
  const memberIds = new Set(input.members.map((m) => m.id))
  const people = [
    ...input.members.map((person) => ({ person, member: true })),
    ...(input.former ?? []).filter((p) => !memberIds.has(p.id)).map((person) => ({ person, member: false })),
  ]

  const lines: CapacityLine[] = people.map(({ person, member }) => {
    const working = wd * rates.hoursPerDay
    const away = input.availability.find((a) => a.personId === person.id && a.sprintId === sprint.id)
    const vacation = away ? (wd - Math.min(Math.max(0, away.daysAvailable), wd)) * rates.hoursPerDay : 0
    const typed = sheet?.people[person.id] ?? {}
    const unknown = typed.unknown ?? 0
    const daysIn = Math.max(0, working - vacation - unknown) / rates.hoursPerDay
    const others = typed.others ?? daysIn * rates.othersPerDay
    const overhead = typed.overhead ?? daysIn * rates.overheadPerDay
    const cap = working - unknown - vacation - others - overhead
    const booked = items.reduce((sum, i) => sum + (i.hours[person.id] ?? 0), 0)
    return {
      person, member,
      working: r2(working), unknown: r2(unknown), vacation: r2(vacation),
      others: r2(others), othersTyped: typed.others != null,
      overhead: r2(overhead), overheadTyped: typed.overhead != null,
      capacity: r2(cap), booked: r2(booked), left: r2(cap - booked),
    }
  })

  const shown = new Set(lines.map((l) => l.person.id))
  const byId = new Map(input.tasks.map((t) => [t.id, t]))
  const columns: CapacityColumn[] = items.map((item) => ({
    item,
    task: item.taskId ? byId.get(item.taskId) ?? null : null,
    total: r2(Object.entries(item.hours).reduce((sum, [id, h]) => sum + (shown.has(id) ? h : 0), 0)),
  }))

  const sum = (k: keyof CapacitySheet['totals']) => r2(lines.reduce((s, l) => s + l[k], 0))
  return {
    workingDays: wd,
    rates,
    lines,
    columns,
    totals: {
      working: sum('working'), unknown: sum('unknown'), vacation: sum('vacation'), others: sum('others'),
      overhead: sum('overhead'), capacity: sum('capacity'), booked: sum('booked'), left: sum('left'),
    },
  }
}
