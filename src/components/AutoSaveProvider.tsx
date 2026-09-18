import { createContext, useContext } from 'react'
import { useAutoSave } from '../hooks/useAutoSave'

type Api = ReturnType<typeof useAutoSave>

const Ctx = createContext<Api | null>(null)

/**
 * One autosave for the whole app. Settings shows and drives it, but it has to
 * keep running while you are anywhere else — mounting the hook on the Settings
 * screen would mean the folder only stayed current while you were looking at it.
 */
export function AutoSaveProvider({ children }: { children: React.ReactNode }) {
  const api = useAutoSave()
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useAutoSaveApi(): Api {
  const api = useContext(Ctx)
  if (!api) throw new Error('useAutoSaveApi needs an AutoSaveProvider above it')
  return api
}
