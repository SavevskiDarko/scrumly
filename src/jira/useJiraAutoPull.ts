import { liveQuery } from 'dexie'
import { useEffect } from 'react'
import { db } from '../db/schema'
import { jiraBridge } from '../desktop/bridge'
import { pullAutomatic } from './pull'

export const AUTO_PULL_MINUTES = 15

/** Long enough that typing a column's new name is one change, not one per key. */
const COLUMNS_SETTLE_MS = 3_000

/**
 * Keeps linked teams current while the desktop app is open: once shortly after
 * start-up, then on a timer, and again whenever the columns change. Does
 * nothing in a browser, where Jira cannot be reached — those devices get the
 * imported rows through sync instead.
 */
export function useJiraAutoPull() {
  useEffect(() => {
    if (!jiraBridge()) return
    // Not at once: start-up is also when the desktop file is being loaded.
    const first = window.setTimeout(() => { void pullAutomatic() }, 10_000)
    const every = window.setInterval(() => { void pullAutomatic() }, AUTO_PULL_MINUTES * 60_000)

    // A pull is what puts each issue in a column, so a column added, renamed,
    // reordered or removed would otherwise sit waiting for the timer.
    let seen: string | null = null
    let settle: number | undefined
    const columns = liveQuery(() => db.statuses.orderBy('order').toArray()).subscribe((rows) => {
      const shape = JSON.stringify(rows.map((s) => [s.id, s.name, s.countsAsActive, s.isDone]))
      if (seen !== null && shape !== seen) {
        window.clearTimeout(settle)
        settle = window.setTimeout(() => { void pullAutomatic() }, COLUMNS_SETTLE_MS)
      }
      seen = shape
    })

    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
      window.clearTimeout(settle)
      columns.unsubscribe()
    }
  }, [])
}
