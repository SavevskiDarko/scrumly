import Dexie from 'dexie'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { backup } from '../repo'
import { db } from '../db/schema'
import { type DesktopInfo, desktopApi, isDesktop } from './bridge'

const DEBOUNCE = 2500

export type DesktopSaveState = 'off' | 'idle' | 'saving' | 'saved' | 'failed' | 'held'

/**
 * How startup went. Worth keeping rather than collapsing to a boolean, because
 * `held` is the one case where the app must not write, and Settings has to be
 * able to say why.
 */
export type BootMode = 'browser' | 'fresh' | 'restored' | 'kept' | 'held'

export interface DesktopStatus {
  state: DesktopSaveState
  boot: BootMode
  info: DesktopInfo | null
  lastSavedAt: number | null
  error: string | null
  /** How many tasks and people came back off disk, for the startup toast. */
  restored: { tasks: number; people: number } | null
}

interface DesktopContextValue {
  status: DesktopStatus
  saveNow: () => Promise<void>
  loadFromFile: () => Promise<{ ok: boolean; error?: string; counts?: Record<string, number> }>
  chooseFolder: () => Promise<void>
  reveal: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<DesktopContextValue | null>(null)

const IDLE: DesktopStatus = {
  state: 'off', boot: 'browser', info: null, lastSavedAt: null, error: null, restored: null,
}

/** Empty means empty of *content*: a settings row is created before any team is. */
async function databaseIsEmpty(): Promise<boolean> {
  return (await db.teams.count()) === 0 && (await db.tasks.count()) === 0
}

/**
 * Keeps the JSON file on disk and the live database in step.
 *
 * Startup is the part that matters. The database is whatever this install's
 * IndexedDB happens to hold, which after a reinstall, a profile reset or a
 * first run on a new machine is nothing at all. So: if there is a file and the
 * database is empty, the file wins and is loaded. If the database already has
 * work in it, it wins and the file is brought up to date behind it. Those two
 * rules are the whole of "it remembers everything".
 *
 * The case that needs care is a file that exists but cannot be read back. That
 * must never be followed by an autosave, or a one-line parse error turns into
 * an empty file where the data used to be. `held` blocks every write until
 * someone looks at it.
 */
export function DesktopProvider({ children }: { children: React.ReactNode }) {
  const [booted, setBooted] = useState(() => !isDesktop())
  const [status, setStatus] = useState<DesktopStatus>(IDLE)

  const running = useRef(false)
  const again = useRef(false)
  const timer = useRef<number | null>(null)
  // Read inside flush(), which is created once: state would be stale there.
  const held = useRef(false)

  const flush = useCallback(async () => {
    const api = desktopApi()
    if (!api || held.current) return
    if (running.current) { again.current = true; return }
    running.current = true
    setStatus((s) => ({ ...s, state: 'saving' }))
    try {
      const snapshot = await backup.snapshot()
      const write = await api.save(snapshot)
      const info = await api.info()
      setStatus((s) => ({ ...s, state: 'saved', info, lastSavedAt: write.at, error: null }))
    } catch (err) {
      setStatus((s) => ({
        ...s, state: 'failed',
        error: err instanceof Error ? err.message : 'Could not write to the data folder',
      }))
    } finally {
      running.current = false
      if (again.current) { again.current = false; void flush() }
    }
  }, [])

  const schedule = useCallback(() => {
    if (!isDesktop() || held.current) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void flush() }, DEBOUNCE)
  }, [flush])

  // Startup: load the file before anything downstream mounts and starts
  // writing. Children are not rendered until this has settled.
  useEffect(() => {
    const api = desktopApi()
    if (!api) return
    let cancelled = false

    void (async () => {
      let next: DesktopStatus = { ...IDLE, state: 'idle', boot: 'fresh' }
      try {
        const raw = await api.load()
        if (raw === null || raw === undefined) {
          next.boot = 'fresh'
        } else if (await databaseIsEmpty()) {
          const result = await backup.restore(raw)
          if (result.ok) {
            next.boot = 'restored'
            next.restored = { tasks: result.counts?.tasks ?? 0, people: result.counts?.people ?? 0 }
          } else {
            // A file we cannot read is still somebody's data. Refuse to write.
            held.current = true
            next = { ...next, boot: 'held', state: 'held', error: result.error ?? 'That data file could not be read.' }
          }
        } else {
          next.boot = 'kept'
        }
        next.info = await api.info()
      } catch (err) {
        held.current = true
        next = {
          ...next, boot: 'held', state: 'held',
          error: err instanceof Error ? err.message : 'Could not read the data folder',
        }
      }
      if (cancelled) return
      setStatus(next)
      setBooted(true)
      // Nothing was on disk, or the database was ahead of it: get the file
      // current straight away rather than waiting for the next edit.
      if (next.boot === 'fresh' || next.boot === 'kept') void flush()
    })()

    return () => { cancelled = true }
  }, [flush])

  useEffect(() => {
    if (!isDesktop()) return
    const on = () => schedule()
    Dexie.on('storagemutated', on)
    return () => { Dexie.on.storagemutated.unsubscribe(on) }
  }, [schedule])

  // A pending write must survive a reload, and the main process calls this
  // before quitting so the last few seconds of work are never lost.
  useEffect(() => {
    if (!isDesktop()) return
    const onHide = () => { if (timer.current) void flush() }
    window.__scrumlyFlush = async () => { await flush() }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      delete window.__scrumlyFlush
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [flush])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const refresh = useCallback(async () => {
    const api = desktopApi()
    if (!api) return
    setStatus((s) => ({ ...s, info: null }))
    const info = await api.info()
    setStatus((s) => ({ ...s, info }))
  }, [])

  /** The deliberate opposite of startup: the file wins, whatever is loaded. */
  const loadFromFile = useCallback(async () => {
    const api = desktopApi()
    if (!api) return { ok: false, error: 'Not running as a desktop app' }
    const raw = await api.load()
    if (raw === null || raw === undefined) return { ok: false, error: 'There is no data file to load yet' }
    const result = await backup.restore(raw)
    if (result.ok) {
      held.current = false
      setStatus((s) => ({ ...s, state: 'idle', boot: 'restored', error: null }))
    }
    return result
  }, [])

  const chooseFolder = useCallback(async () => {
    const api = desktopApi()
    if (!api) return
    const info = await api.chooseDir()
    if (!info) return
    setStatus((s) => ({ ...s, info }))
    // The new folder is empty until something is written into it.
    await flush()
  }, [flush])

  const reveal = useCallback(async () => { await desktopApi()?.reveal() }, [])

  if (!booted) {
    return <div className="empty" style={{ marginTop: 80 }}>Opening your data…</div>
  }

  return (
    <Ctx.Provider value={{ status, saveNow: flush, loadFromFile, chooseFolder, reveal, refresh }}>
      {children}
    </Ctx.Provider>
  )
}

export function useDesktop(): DesktopContextValue {
  const api = useContext(Ctx)
  if (!api) throw new Error('useDesktop needs a DesktopProvider above it')
  return api
}
