import { db } from '../db/schema'
import type { ID, PiObjective, PiRisk, PiVote, ProgramIncrement, RoamStatus } from '../db/types'
import { newId } from './ids'

export const ROAM_STATUSES: RoamStatus[] = ['owned', 'mitigated', 'accepted', 'resolved']

export const pi = {
  list: () => db.programIncrements.orderBy('startDate').reverse().toArray(),
  get: (id: ID) => db.programIncrements.get(id),
  active: () => db.programIncrements.filter((p) => p.state === 'active').first(),

  async create(input: { name?: string; startDate: string; endDate: string; teamIds: ID[] }): Promise<{ ok: boolean; reason?: string; pi?: ProgramIncrement }> {
    if (input.endDate < input.startDate) return { ok: false, reason: 'A PI cannot end before it starts' }
    if (input.teamIds.length === 0) return { ok: false, reason: 'Pick at least one team' }
    const count = await db.programIncrements.count()
    const row: ProgramIncrement = {
      id: newId(),
      name: input.name?.trim() || `PI ${count + 1}`,
      startDate: input.startDate,
      endDate: input.endDate,
      state: 'planning',
      teamIds: [...new Set(input.teamIds)],
      createdAt: Date.now(),
      closedAt: null,
    }
    await db.programIncrements.add(row)
    return { ok: true, pi: row }
  },

  async update(
    id: ID,
    patch: Partial<Pick<ProgramIncrement, 'name' | 'startDate' | 'endDate' | 'teamIds'>>,
  ): Promise<{ ok: boolean; reason?: string }> {
    const row = await db.programIncrements.get(id)
    if (!row) return { ok: false, reason: 'That PI is gone' }
    const next: Partial<ProgramIncrement> = { ...patch }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) return { ok: false, reason: 'A PI needs a name' }
      next.name = name
    }
    const startDate = next.startDate ?? row.startDate
    const endDate = next.endDate ?? row.endDate
    if (endDate < startDate) return { ok: false, reason: 'A PI cannot end before it starts' }
    if (patch.teamIds && patch.teamIds.length === 0) return { ok: false, reason: 'A PI needs at least one team' }
    await db.programIncrements.update(id, next)
    return { ok: true }
  },

  /** One active PI at a time, like a sprint — otherwise "the program board" is ambiguous. */
  async activate(id: ID): Promise<{ ok: boolean; reason?: string }> {
    const row = await db.programIncrements.get(id)
    if (!row) return { ok: false, reason: 'That PI is gone' }
    const running = await pi.active()
    if (running && running.id !== id) return { ok: false, reason: `${running.name} is still running — close it first` }
    await db.programIncrements.update(id, { state: 'active' })
    return { ok: true }
  },

  async close(id: ID) {
    await db.programIncrements.update(id, { state: 'closed', closedAt: Date.now() })
  },

  async remove(id: ID) {
    await db.transaction('rw', db.programIncrements, db.piObjectives, db.piRisks, db.piVotes, async () => {
      await db.piObjectives.where('piId').equals(id).delete()
      await db.piRisks.where('piId').equals(id).delete()
      await db.piVotes.where('piId').equals(id).delete()
      await db.programIncrements.delete(id)
    })
  },
}

export const piObjectives = {
  listForPi: (piId: ID) => db.piObjectives.where('piId').equals(piId).sortBy('createdAt'),

  async add(input: { piId: ID; teamId: ID; title: string; businessValue?: number; committed?: boolean }) {
    const title = input.title.trim()
    if (!title) throw new Error('An objective needs a title')
    const row: PiObjective = {
      id: newId(),
      piId: input.piId,
      teamId: input.teamId,
      title,
      businessValue: clampValue(input.businessValue ?? 5),
      committed: input.committed ?? true,
      actualValue: null,
      createdAt: Date.now(),
    }
    await db.piObjectives.add(row)
    return row
  },

  async update(id: ID, patch: Partial<Pick<PiObjective, 'title' | 'businessValue' | 'committed' | 'actualValue'>>) {
    const next: Partial<PiObjective> = { ...patch }
    if (next.businessValue !== undefined) next.businessValue = clampValue(next.businessValue)
    if (next.actualValue !== undefined && next.actualValue !== null) next.actualValue = clampValue(next.actualValue)
    if (typeof next.title === 'string') {
      const title = next.title.trim()
      if (!title) return
      next.title = title
    }
    await db.piObjectives.update(id, next)
  },

  async remove(id: ID) {
    await db.piObjectives.delete(id)
  },
}

function clampValue(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)))
}

export const piRisks = {
  listForPi: (piId: ID) => db.piRisks.where('piId').equals(piId).sortBy('createdAt'),

  async add(input: { piId: ID; description: string; ownerPersonId?: ID | null }) {
    const description = input.description.trim()
    if (!description) throw new Error('A risk needs a description')
    const row: PiRisk = {
      id: newId(),
      piId: input.piId,
      description,
      ownerPersonId: input.ownerPersonId ?? null,
      status: 'owned',
      createdAt: Date.now(),
    }
    await db.piRisks.add(row)
    return row
  },

  async update(id: ID, patch: Partial<Pick<PiRisk, 'description' | 'ownerPersonId' | 'status'>>) {
    await db.piRisks.update(id, patch)
  },

  /** Cycles Owned -> Mitigated -> Accepted -> Resolved -> Owned, the order a risk usually moves through. */
  async cycleStatus(id: ID) {
    const row = await db.piRisks.get(id)
    if (!row) return
    const i = ROAM_STATUSES.indexOf(row.status)
    await db.piRisks.update(id, { status: ROAM_STATUSES[(i + 1) % ROAM_STATUSES.length] })
  },

  async remove(id: ID) {
    await db.piRisks.delete(id)
  },
}

export const piVotes = {
  listForPi: (piId: ID) => db.piVotes.where('piId').equals(piId).toArray(),

  async set(piId: ID, teamId: ID, vote: number) {
    const clamped = Math.max(1, Math.min(5, Math.round(vote)))
    const existing = await db.piVotes.where('[piId+teamId]').equals([piId, teamId]).first()
    if (existing) {
      await db.piVotes.update(existing.id, { vote: clamped, at: Date.now() })
      return
    }
    const row: PiVote = { id: newId(), piId, teamId, vote: clamped, at: Date.now() }
    await db.piVotes.add(row)
  },
}
