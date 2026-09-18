import { useSyncExternalStore } from 'react'

/**
 * Whether the app is currently rendering dark.
 *
 * The CSS handles itself, but a few places pick colours in JavaScript — avatar
 * palettes and the Excalidraw theme. Reading the DOM during render made those
 * keep the old palette until something unrelated re-rendered them, so the
 * switch in Settings appeared to half-work. This subscribes instead.
 */
function read(): boolean {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr) return attr === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function subscribe(onChange: () => void): () => void {
  // 'system' removes the attribute, so both sources have to be watched.
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener('change', onChange)
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => {
    media?.removeEventListener('change', onChange)
    observer.disconnect()
  }
}

export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
