import { useEffect, useState } from 'react'

export interface Route {
  screen: string
  params: URLSearchParams
}

function read(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '') || 'today'
  const [screen, query = ''] = raw.split('?')
  return { screen: screen || 'today', params: new URLSearchParams(query) }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export function go(screen: string, params: Record<string, string | null> = {}) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  const s = q.toString()
  window.location.hash = `#/${screen}${s ? `?${s}` : ''}`
}

/** Adds or removes one query parameter without leaving the screen. */
export function setParam(key: string, value: string | null) {
  const { screen, params } = read()
  if (value) params.set(key, value)
  else params.delete(key)
  const s = params.toString()
  window.location.hash = `#/${screen}${s ? `?${s}` : ''}`
}
