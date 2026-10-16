import { db } from '../db/schema'
import type { Note, Team } from '../db/types'
import { SCOPED_TABLES, scopeOf, type LocalScope } from '../repo/localOnly'

/*
 * What the assistant may read.
 *
 * Whatever it reads is sent to Anthropic. That is fine for a team that already
 * syncs, and exactly what "kept on this computer only" exists to prevent — so
 * those teams are hidden, along with everything that hangs off them, unless
 * the user has let that one team through on purpose (Settings → Assistant).
 *
 * "Hangs off them" is decided by localOnly.ts, the same rule sync, backups and
 * the data file use, so the assistant can never see something those keep back
 * by a different reading of it.
 */

export const sharedWithAssistant = (t: Team): boolean => !t.localOnly || t.assistant === true

/** Private notes are the user's own, and stay out even for a team that is shared. */
export const readableNote = (n: Note): boolean => !n.isPrivate

export interface Sight {
  /** The teams it may see, by name. */
  teams: Team[]
  /** Teams kept back from it, by name, so it can say why something is missing. */
  closed: Team[]
  sees(table: string, id: string | number): boolean
}

export async function sight(): Promise<Sight> {
  const all = await db.teams.orderBy('name').toArray()
  const closedIds = new Set(all.filter((t) => !sharedWithAssistant(t)).map((t) => t.id))

  let hidden: LocalScope = scopeOf({})
  if (closedIds.size) {
    // The same rows the local-only rule would keep here, but judged as if only
    // the closed teams were local: one that has been shared counts as travelling.
    const tables: Record<string, unknown[]> = {
      teams: all.map((t) => ({ ...t, localOnly: closedIds.has(t.id) })),
    }
    for (const name of SCOPED_TABLES) {
      if (name !== 'teams') tables[name] = await db.table(name).toArray()
    }
    hidden = scopeOf(tables)
  }

  return {
    teams: all.filter((t) => !closedIds.has(t.id)),
    closed: all.filter((t) => closedIds.has(t.id)),
    sees: (table, id) => !hidden.has(table, id),
  }
}
