import { useEffect, useMemo, useRef, useState } from 'react'
import { googleBridge, type SheetData } from '../desktop/bridge'
import type { SheetRef } from '../repo/sheets'
import { refreshGoogle } from './GoogleConnect'
import { ROW_CAP, buildTable, columnName, linkIn, looksNumeric } from './table'

// Often enough that a sheet someone else is editing does not look stale for
// long; well inside Google's quota of sixty reads a minute.
const REFRESH_MS = 60_000

/**
 * A Google Sheet's values in a table of Scrumly's own, read through Google's
 * API — how a private sheet shows inside the app at all. Read-only: it is
 * Google's data, displayed, and the editor is a click away in Open in window.
 */
export function SheetTable({ sheetRef, connected, reload, onConnect }: {
  sheetRef: SheetRef
  connected: boolean
  /** Bumped by the screen's Reload. */
  reload: number
  onConnect: () => void
}) {
  const [bridge] = useState(googleBridge)
  const [tab, setTab] = useState<string | null>(sheetRef.gid)
  const [data, setData] = useState<SheetData | null>(null)
  const [error, setError] = useState<{ message: string; expired?: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  // Only the newest read may land: a slow answer for the tab just left must not
  // replace the one just opened.
  const latest = useRef(0)

  async function load() {
    if (!bridge || !connected) return
    const mine = ++latest.current
    setLoading(true)
    const res = await bridge.read(sheetRef.fileId, tab)
    if (mine !== latest.current) return
    setLoading(false)
    if (res.ok) {
      setData(res.data)
      setError(null)
      setUpdatedAt(Date.now())
    } else {
      setError({ message: res.message, expired: res.expired })
      if (res.expired) void refreshGoogle()
    }
  }

  useEffect(() => { void load() }, [connected, sheetRef.fileId, tab, reload])

  useEffect(() => {
    if (!connected) return
    const visible = () => document.visibilityState === 'visible'
    const timer = window.setInterval(() => { if (visible()) void load() }, REFRESH_MS)
    const onShow = () => { if (visible()) void load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onShow) }
  }, [connected, sheetRef.fileId, tab])

  const frozen = data?.tabs.find((t) => t.id === data.tab)?.frozenRows ?? 0
  const table = useMemo(() => buildTable(data?.values ?? [], frozen, filter), [data, frozen, filter])

  if (!connected) {
    return (
      <div className="sheet-cover">
        <div className="empty">
          <strong>Connect Google to show this sheet here</strong>
          Google does not let anyone sign in inside a desktop app. Connected once through your browser, Scrumly can
          read your sheets and show them here.
          <div style={{ marginTop: 14 }}><button className="btn primary" onClick={onConnect}>Connect Google</button></div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="sheet-cover">
        <div className="empty">
          {error ? (
            <>
              <strong>Google did not hand this sheet over</strong>
              {error.message}
              <div style={{ marginTop: 14 }}>
                {error.expired
                  ? <button className="btn primary" onClick={onConnect}>Connect again</button>
                  : <button className="btn" onClick={() => void load()}>Try again</button>}
              </div>
            </>
          ) : 'Reading the sheet from Google…'}
        </div>
      </div>
    )
  }

  const time = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <div className="gs">
      <div className="gs-bar">
        {data.tabs.length > 1 && (
          <div className="gs-tabs" role="tablist" aria-label="Tabs in this sheet">
            {data.tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={t.id === data.tab}
                className={`gs-tab${t.id === data.tab ? ' on' : ''}`} onClick={() => { setTab(t.id); setFilter('') }}>{t.title}</button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <input className="input gs-filter" value={filter} placeholder="Filter rows" onChange={(e) => setFilter(e.target.value)} />
        <span className="small faint gs-when" title="Read again every minute while this is open">
          {loading ? 'Updating…' : `Updated ${time}`}
        </span>
      </div>
      {error && (
        <div className="gs-note">
          {error.message}
          {error.expired && <button className="btn sm" onClick={onConnect}>Connect again</button>}
        </div>
      )}

      {data.values.length === 0 ? (
        <div className="empty">This tab is empty.</div>
      ) : (
        <div className="gs-scroll">
          <table className="gs-grid">
            <thead>
              <tr>
                <th className="gs-corner" />
                {Array.from({ length: table.width }, (_, i) => <th key={i}>{columnName(i)}</th>)}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                // Only the first frozen row is pinned: a second would have to know the first one's height.
                <tr key={r.index} className={r.frozen ? (r.index === 0 ? 'gs-frozen' : 'gs-head') : undefined}>
                  <th className="gs-num">{r.index + 1}</th>
                  {Array.from({ length: table.width }, (_, i) => {
                    const cell = r.cells[i] ?? ''
                    const link = linkIn(cell)
                    return (
                      <td key={i} className={looksNumeric(cell) ? 'num' : undefined} title={cell.length > 40 ? cell : undefined}>
                        {link ? <a href={link} target="_blank" rel="noreferrer">{cell}</a> : cell}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {filter.trim() && table.rows.every((r) => r.index < Math.max(frozen, 1)) && (
            <div className="empty">No row has "{filter.trim()}" in it.</div>
          )}
        </div>
      )}
      {table.hidden > 0 && (
        <div className="gs-foot small faint">
          Showing the first {ROW_CAP.toLocaleString()} of {table.matched.toLocaleString()} rows. Filter to find the
          rest, or open it in Google with Open in window.
        </div>
      )}
    </div>
  )
}
