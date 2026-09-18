import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from '../db/schema'
import { useTeamPeople } from '../hooks/useTeamPeople'
import { parseQuickAdd, tasks as taskRepo } from '../repo'
import { Avatar } from './Avatar'
import { useToast } from './Toast'

export function PasteTasks({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [statusId, setStatusId] = useState('')
  const [busy, setBusy] = useState(false)

  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useTeamPeople(teamId)
  const target = statusId || statuses[0]?.id || ''

  const rows = useMemo(() => text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = parseQuickAdd(line)
      const person = parsed.assigneeName
        ? people.find((p) => p.name.toLowerCase().startsWith(parsed.assigneeName!.toLowerCase())) ?? null
        : null
      return { parsed, person, unmatched: Boolean(parsed.assigneeName && !person) }
    })
    .filter((r) => r.parsed.title), [text, people])

  async function add() {
    setBusy(true)
    try {
      for (const r of rows) {
        await taskRepo.create({
          teamId, statusId: target, title: r.parsed.title,
          assigneeId: r.person?.id ?? null,
          priority: r.parsed.priority ?? 'normal',
          size: r.parsed.size, tags: r.parsed.tags,
        })
      }
      toast(`Added ${rows.length} task${rows.length === 1 ? '' : 's'}`)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add those', true)
      setBusy(false)
    }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-label="Paste a list of tasks">
        <div className="modal-head">
          <b>Paste a list</b>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          <div className="paste-grid">
            <div className="field">
              <span className="label">One task per line</span>
              <textarea
                className="textarea"
                autoFocus
                style={{ minHeight: 190, lineHeight: 1.8 }}
                placeholder={'Dispute handling @jakim\nPartial refunds\nWebhook signature docs @elena !low\nRetry dashboard ~5 #support'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <span className="small faint">Same syntax as the board: @person · !priority · ~size · #tag</span>
            </div>

            <div className="field">
              <span className="label">{rows.length === 0 ? 'Preview' : `Preview — ${rows.length} task${rows.length === 1 ? '' : 's'}`}</span>
              <div className="paste-preview">
                {rows.length === 0 && <span className="faint small">Nothing yet.</span>}
                {rows.map((r, i) => (
                  <div key={i} className="paste-row">
                    <Avatar person={r.person} size={18} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.parsed.title}
                    </span>
                    {r.unmatched && <span className="chip warn" title={`No active person starting with "${r.parsed.assigneeName}"`}>?</span>}
                    {r.parsed.priority && <span className="chip">{r.parsed.priority}</span>}
                    {r.parsed.size != null && <span className="chip">{r.parsed.size}p</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="small faint">Into</span>
          <select className="select" style={{ width: 150 }} value={target} onChange={(e) => setStatusId(e.target.value)}>
            {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {rows.some((r) => r.unmatched) && (
            <span className="small" style={{ color: 'var(--alert)' }}>
              Some names did not match anyone — those arrive unassigned.
            </span>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={rows.length === 0 || busy || !target} onClick={add}>
            {busy ? 'Adding…' : `Add ${rows.length || ''} task${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </>
  )
}
