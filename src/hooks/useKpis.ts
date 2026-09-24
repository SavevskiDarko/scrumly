import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'
import type { Availability, ID, Kpi, KpiEntry, Person, Sprint, Status, StatusEvent, Task } from '../db/types'
import { readKpi, type BoardHistory, type KpiReading } from '../repo'

/**
 * The whole task history, for replaying board KPIs. Nothing is loaded until a
 * board KPI exists, so a team measured only by hand never pays for it.
 */
function useBoardHistory(enabled: boolean): BoardHistory {
  const sprints = useLiveQuery(
    () => (enabled ? db.sprints.toArray() : Promise.resolve([] as Sprint[])), [enabled], [] as Sprint[])
  const tasks = useLiveQuery(
    () => (enabled ? db.tasks.toArray() : Promise.resolve([] as Task[])), [enabled], [] as Task[])
  const statusEvents = useLiveQuery(
    () => (enabled ? db.statusEvents.toArray() : Promise.resolve([] as StatusEvent[])), [enabled], [] as StatusEvent[])
  const statuses = useLiveQuery(
    () => (enabled ? db.statuses.toArray() : Promise.resolve([] as Status[])), [enabled], [] as Status[])
  const availability = useLiveQuery(
    () => (enabled ? db.availability.toArray() : Promise.resolve([] as Availability[])), [enabled], [] as Availability[])
  return { sprints, tasks, statusEvents, statuses, availability }
}

/** Every KPI these people have, retired ones included, read and keyed by person. */
export function useKpiReadings(people: Person[]): Map<ID, KpiReading[]> {
  const ids = people.map((p) => p.id)
  const idKey = ids.join(',')
  const rows = useLiveQuery(
    () => (ids.length ? db.kpis.where('personId').anyOf(ids).sortBy('createdAt') : Promise.resolve([] as Kpi[])),
    [idKey], [] as Kpi[],
  )
  const manualIds = rows.filter((k) => k.source === 'manual').map((k) => k.id)
  const entries = useLiveQuery(
    () => (manualIds.length ? db.kpiEntries.where('kpiId').anyOf(manualIds).toArray() : Promise.resolve([] as KpiEntry[])),
    [manualIds.join(',')], [] as KpiEntry[],
  )
  const history = useBoardHistory(rows.some((k) => k.source !== 'manual'))

  const personById = new Map(people.map((p) => [p.id, p]))
  const out = new Map<ID, KpiReading[]>()
  for (const kpi of rows) {
    const person = personById.get(kpi.personId)
    if (!person) continue
    const list = out.get(kpi.personId) ?? []
    list.push(readKpi(kpi, entries, person, history))
    out.set(kpi.personId, list)
  }
  return out
}
