import { useEffect } from 'react'
import { jiraBridge } from '../desktop/bridge'
import { pullAutomatic } from './pull'

export const AUTO_PULL_MINUTES = 15

/**
 * Keeps linked teams current while the desktop app is open: once shortly after
 * start-up, then on a timer. Does nothing in a browser, where Jira cannot be
 * reached — those devices get the imported rows through sync instead.
 */
export function useJiraAutoPull() {
  useEffect(() => {
    if (!jiraBridge()) return
    // Not at once: start-up is also when the desktop file is being loaded.
    const first = window.setTimeout(() => { void pullAutomatic() }, 10_000)
    const every = window.setInterval(() => { void pullAutomatic() }, AUTO_PULL_MINUTES * 60_000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
    }
  }, [])
}
