import { createContext, useCallback, useContext, useEffect, useState } from 'react'

type Toast = { message: string; bad?: boolean } | null
const Ctx = createContext<(message: string, bad?: boolean) => void>(() => {})

export function useToast() { return useContext(Ctx) }

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast>(null)
  const show = useCallback((message: string, bad = false) => setToast({ message, bad }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && <div className={`toast${toast.bad ? ' bad' : ''}`} role="status">{toast.message}</div>}
    </Ctx.Provider>
  )
}
