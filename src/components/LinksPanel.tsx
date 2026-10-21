import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import type { ExternalLink, ID } from '../db/types'
import { externalLinks as repo, linkHost, webUrl } from '../repo'
import { useToast } from './Toast'

/**
 * Where a task's work lives outside Scrumly. Each link opens in the real
 * browser, never inside the app: the desktop app sends every http(s) link
 * there, and nothing but http(s) can be saved here.
 */
export function LinksPanel({ taskId }: { taskId: ID }) {
  const toast = useToast()
  const links = useLiveQuery(() => repo.forTask(taskId), [taskId], [] as ExternalLink[])
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')

  const cancel = () => { setAdding(false); setUrl(''); setLabel('') }

  async function add() {
    if (!url.trim()) return
    const r = await repo.add(taskId, { url, label })
    if (!r.ok) { toast(r.reason, true); return }
    cancel()
  }

  const keys = (e: React.KeyboardEvent) => {
    // Closes the form, not the drawer around it.
    if (e.key === 'Escape') { e.stopPropagation(); cancel() }
    if (e.key === 'Enter') { e.preventDefault(); void add() }
  }

  return (
    <div>
      <p className="panel-title">
        Links
        <span className="spacer" />
        {!adding && <button className="btn ghost sm" onClick={() => setAdding(true)}>Add a link…</button>}
      </p>

      {links.length === 0 && !adding && (
        <p className="small faint" style={{ margin: 0 }}>
          Nothing linked. The pull request, the design, the vendor's ticket: wherever someone picking this up would go
          looking.
        </p>
      )}

      {links.length > 0 && (
        <div className="dep-list">
          {links.map((l) => {
            // Checked again here, not only when saved: a backup or another
            // device can bring in a row this screen never vetted.
            const href = webUrl(l.url)
            // A link added without a label is already called by its site; saying it twice is noise.
            const host = href ? linkHost(href) : null
            const text = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const
            return (
              <div key={l.id} className="dep-row">
                {href ? (
                  <a className="linkish" href={href} target="_blank" rel="noreferrer" title={href}
                    style={{ ...text, fontWeight: 500, textDecoration: 'none' }}>
                    {l.label}
                  </a>
                ) : <span style={text} title="Not a web link, so it does not open">{l.label}</span>}
                <span className="small faint" style={{ flex: 'none', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {href ? (host === l.label ? '↗' : `${host} ↗`) : l.url}
                </span>
                <button className="btn ghost sm" title="Remove this link" onClick={() => void repo.remove(l.id)}>×</button>
              </div>
            )
          })}
        </div>
      )}

      {adding && (
        <div className="dep-add">
          <input className="input" autoFocus placeholder="https://github.com/acme/payments/pull/412"
            value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={keys} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="input" placeholder="What it is (optional: the site's name if left blank)"
              value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={keys} />
            <button className="btn primary sm" disabled={!url.trim()} onClick={() => void add()}>Add</button>
            <button className="btn ghost sm" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
