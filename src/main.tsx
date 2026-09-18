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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
