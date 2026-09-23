/// <reference types="vite/client" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

try {
  // Falls back to the old key so the theme survives the rename.
  const saved = localStorage.getItem('scrumly-theme') ?? localStorage.getItem('cadence-theme')
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved)
} catch {
  /* storage can be unavailable; the system preference still applies */
}

// The hosted build installs as an app and opens offline (see pwa/sw.js). Not
// in dev, where it would cache over hot reload; not in the single-file build,
// which has no worker to register; and not in the desktop app, which serves
// itself from app:// and has nothing to gain.
if (
  import.meta.env.PROD && import.meta.env.MODE !== 'single' && 'serviceWorker' in navigator
  && location.protocol.startsWith('http') && !window.scrumlyDesktop
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* the app works the same without it, just not offline */
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
