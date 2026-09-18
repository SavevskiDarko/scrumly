import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'
import type { Person } from '../db/types'
import { people } from '../repo'

/** Active members of one team. Every picker and every load figure uses this. */
export function useTeamPeople(teamId: string): Person[] {
  return useLiveQuery(() => people.listActiveForTeam(teamId), [teamId], [] as Person[])
}

/**
 * Team members plus anyone already named on this task, so reassigning does not
 * silently blank out a person who has since moved teams.
 */
export function usePickablePeople(teamId: string, mustInclude: (string | null)[] = []): Person[] {
  const keys = mustInclude.filter(Boolean).join(',')
  return useLiveQuery(async () => {
    const members = await people.listActiveForTeam(teamId)
    const have = new Set(members.map((p) => p.id))
    const extras: Person[] = []
    for (const id of mustInclude) {
      if (!id || have.has(id)) continue
      const p = await db.people.get(id)
      if (p) extras.push(p)
    }
    return [...members, ...extras]
  }, [teamId, keys], [] as Person[])
}
