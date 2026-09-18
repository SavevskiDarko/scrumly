import Dexie from 'dexie'
import { useCallback, useEffect, useRef, useState } from 'react'
import { backup } from '../repo'
import { fileStore } from '../repo/fileStore'

const DEBOUNCE = 2500

export type SaveState = 'off' | 'idle' | 'saving' | 'saved' | 'blocked' | 'failed'

export interface AutoSaveStatus {
  state: SaveState
  /** Folder name, once one is connected. */
  folder: string | null
  lastSavedAt: number | null
  error: string | null
}

/**
 * Mirrors the database into the chosen folder a couple of seconds after
 * anything changes.
 *
 * The signal is Dexie's own storagemutated event, which is what liveQuery uses
 * to know a screen needs re-rendering. Counting rows would have been cheaper
 * but would miss every edit that does not add or remove one — renaming a
 * sprint, moving a card, resolving a blocker.
 */
export function useAutoSave() {
  const [status, setStatus] = useState<AutoSaveStatus>({
    state: 'off', folder: null, lastSavedAt: null, error: null,
  })
  const handle = useRef<FileSystemDirectoryHandle | null>(null)
  const timer = useRef<number | null>(null)
  const running = useRef(false)
  const again = useRef(false)

  const flush = useCallback(async () => {
    if (!handle.current) return
    // A write already in flight: note that another is due rather than
    // interleaving two writers on the same file.
    if (running.current) { again.current = true; return }
    running.current = true
    setStatus((s) => ({ ...s, state: 'saving' }))
    try {
      const granted = await fileStore.permission(handle.current)
      if (granted !== 'granted') {
        setStatus((s) => ({ ...s, state: 'blocked', error: 'Scrumly needs permission to that folder again.' }))
        return
      }
      const snapshot = await backup.snapshot()
      const { at } = await fileStore.write(handle.current, snapshot)
      setStatus((s) => ({ ...s, state: 'saved', lastSavedAt: at, error: null }))
    } catch (err) {
      setStatus((s) => ({
        ...s, state: 'failed',
        error: err instanceof Error ? err.message : 'Could not write to that folder',
      }))
    } finally {
      running.current = false
      if (again.current) { again.current = false; void flush() }
    }
  }, [])

  const schedule = useCallback(() => {
    if (!handle.current) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void flush() }, DEBOUNCE)
  }, [flush])

  const attach = useCallback((h: FileSystemDirectoryHandle | null, state: SaveState) => {
    handle.current = h
    setStatus((s) => ({ ...s, state, folder: h?.name ?? null, error: null }))
    if (h && state === 'idle') void flush()
  }, [flush])

  // Pick up a folder chosen in an earlier session.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const saved = await fileStore.saved()
      if (cancelled || !saved) return
      const granted = await fileStore.permission(saved)
      attach(saved, granted === 'granted' ? 'idle' : 'blocked')
    })()
    return () => { cancelled = true }
  }, [attach])

  useEffect(() => {
    const on = () => schedule()
    Dexie.on('storagemutated', on)
    return () => { Dexie.on.storagemutated.unsubscribe(on) }
  }, [schedule])

  // A pending write must not be lost to a reload or a closed tab.
  useEffect(() => {
    const onHide = () => { if (timer.current) void flush() }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [flush])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const connect = useCallback(async () => {
    const chosen = await fileStore.choose()
    if (chosen) attach(chosen, 'idle')
    return chosen
  }, [attach])

  const reconnect = useCallback(async () => {
    const saved = handle.current ?? (await fileStore.saved())
    if (!saved) return
    const granted = await fileStore.permission(saved, true)
    attach(saved, granted === 'granted' ? 'idle' : 'blocked')
  }, [attach])

  const disconnect = useCallback(async () => {
    await fileStore.forget()
    handle.current = null
    setStatus({ state: 'off', folder: null, lastSavedAt: null, error: null })
  }, [])

  return { status, connect, reconnect, disconnect, saveNow: flush, handle }
}
