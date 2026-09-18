import { db } from '../db/schema'
import type { ID, Person } from '../db/types'
import { hashSeed, initialsOf, newId } from './ids'

export const people = {
  list: () => db.people.orderBy('name').toArray(),
  listActive: () => db.people.filter((p) => p.active).toArray(),
  get: (id: ID) => db.people.get(id),

  /**
   * A person can sit in more than one team, so membership is a multi-entry
   * index rather than a column. Anywhere a list of people is shown to choose
   * from, it must come through here — a global list quietly offers you
   * developers from the other team.
   */
  listForTeam: (teamId: ID) => db.people.where('teamIds').equals(teamId).sortBy('name'),

  listActiveForTeam: (teamId: ID) =>
    db.people.where('teamIds').equals(teamId).filter((p) => p.active).sortBy('name'),

  /** People in no team at all — easy to create by accident, invisible everywhere else. */
  listOrphans: () => db.people.filter((p) => p.teamIds.length === 0).sortBy('name'),

  async setTeams(id: ID, teamIds: ID[]) {
    await db.people.update(id, { teamIds: [...new Set(teamIds)] })
  },

  async toggleTeam(id: ID, teamId: ID) {
    const person = await db.people.get(id)
    if (!person) return
    const next = person.teamIds.includes(teamId)
      ? person.teamIds.filter((t) => t !== teamId)
      : [...person.teamIds, teamId]
    await db.people.update(id, { teamIds: next })
  },

  async create(input: { name: string; role?: string; teamIds?: ID[]; skills?: string[]; notes?: string }) {
    const name = input.name.trim()
    if (!name) throw new Error('A person needs a name')
    const row: Person = {
      id: newId(),
      name,
      role: input.role?.trim() || 'Developer',
      initials: initialsOf(name),
      colorSeed: hashSeed(name),
      skills: input.skills ?? [],
      notes: input.notes ?? '',
      active: true,
      teamIds: input.teamIds ?? [],
      createdAt: Date.now(),
    }
    await db.people.add(row)
    return row
  },

  async update(id: ID, patch: Partial<Omit<Person, 'id' | 'createdAt'>>) {
    const next = { ...patch }
    if (typeof next.name === 'string') next.initials = initialsOf(next.name)
    await db.people.update(id, next)
  },

  /** People are deactivated, never deleted — their name is attached to finished work. */
  async setActive(id: ID, active: boolean) {
    await db.people.update(id, { active })
  },

  /** Parses "Elena, Developer" per line. */
  async createFromList(text: string, teamIds: ID[]) {
    const made: Person[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const [name, role] = line.split(/[,;\t]/).map((s) => s?.trim())
      if (!name) continue
      made.push(await people.create({ name, role: role || undefined, teamIds }))
    }
    return made
  },
}
