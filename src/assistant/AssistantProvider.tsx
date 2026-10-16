import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { db } from '../db/schema'
import { assistantBridge, type AssistantBridge, type AssistantConnection } from '../desktop/bridge'
import { settings as settingsRepo } from '../repo'
import { Conversation } from './conversation'

interface AssistantApi {
  /** Null outside the desktop app: there is nowhere to keep the key. */
  bridge: AssistantBridge | null
  conversation: Conversation | null
  /** Null until the main process has answered. */
  connection: AssistantConnection | null
  refresh(): Promise<void>
  open: boolean
  setOpen(open: boolean | ((was: boolean) => boolean)): void
}

const Ctx = createContext<AssistantApi | null>(null)

// Per device, like the rail: a narrow laptop wants it shut, a wide monitor may not.
const OPEN_KEY = 'scrumly-assistant-open'

function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1' } catch { return false }
}

async function activeTeamId(): Promise<string | null> {
  const cfg = await settingsRepo.get()
  const teams = await db.teams.orderBy('name').toArray()
  return (teams.find((t) => t.id === cfg?.activeTeamId) ?? teams[0])?.id ?? null
}

/**
 * Holds the one conversation for as long as the app is open, so closing the
 * panel or moving between screens does not end it. Ctrl+J shows and hides it.
 */
export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const bridge = useMemo(() => assistantBridge(), [])
  const conversation = useMemo(() => (bridge ? new Conversation(bridge, activeTeamId) : null), [bridge])
  const [connection, setConnection] = useState<AssistantConnection | null>(null)
  const [open, setOpen] = useState(() => Boolean(bridge) && readOpen())

  const refresh = useCallback(async () => {
    if (bridge) setConnection(await bridge.status())
  }, [bridge])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* private mode */ }
  }, [open])

  useEffect(() => {
    if (!bridge) return
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'j') return
      e.preventDefault()
      setOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bridge])

  const api = useMemo(
    () => ({ bridge, conversation, connection, refresh, open: open && Boolean(bridge), setOpen }),
    [bridge, conversation, connection, refresh, open],
  )
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useAssistant(): AssistantApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useAssistant needs an AssistantProvider above it')
  return api
}
