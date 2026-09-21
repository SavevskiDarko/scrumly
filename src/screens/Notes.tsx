import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Conversion, NoteType } from '../db/types'
import { setParam } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import { formatDate } from '../lib/dates'
import { NOTE_TYPES, notes as repo } from '../repo'

const labelOf = (t: NoteType) => NOTE_TYPES.find((x) => x.value === t)?.label ?? t

export function Notes({ teamId }: { teamId: string }) {
  const toast = useToast()
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<NoteType | 'all'>('all')
  const [body, setBody] = useState('')
  const [sel, setSel] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const rows = useLiveQuery(() => repo.list(), [], [])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useTeamPeople(teamId)
  const note = useLiveQuery(async () => (selected ? await repo.get(selected) : undefined), [selected])
  const conversions = useLiveQuery(async () => (selected ? await repo.conversionsFor(selected) : []), [selected], [] as Conversion[])
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], [])
  const follow = useLiveQuery(() => db.followUps.toArray(), [], [])

  const mine = rows.filter((n) => n.teamId === teamId || n.teamId === null)
  const visible = filter === 'all' ? mine : mine.filter((n) => n.type === filter)

  useEffect(() => { if (!selected && rows.length) setSelected(rows[0].id) }, [rows.length, selected])
  useEffect(() => { if (note) setBody(note.body) }, [note?.id])

  /**
   * The body used to save only on blur, so switching notes with the keyboard or
   * navigating away lost whatever had just been typed. This autosaves like the
   * canvas does, and flushes when the note changes or the screen unmounts.
   */
  const pending = useRef<{ noteId: string; body: string } | null>(null)
  const saveTimer = useRef<number | null>(null)

  const flush = useCallback(async () => {
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null }
    const p = pending.current
    if (!p) return
    pending.current = null
    await repo.update(p.noteId, { body: p.body })
  }, [])

  function editBody(next: string) {
    setBody(next)
    if (!note) return
    pending.current = { noteId: note.id, body: next }
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flush() }, 600)
  }

  useEffect(() => () => { void flush() }, [flush, note?.id])

  function captureSelection() {
    const el = areaRef.current
    if (!el) return
    setSel(el.value.slice(el.selectionStart, el.selectionEnd).trim())
  }

  async function convert(to: 'task' | 'followUp') {
    if (!note) return
    const result = await repo.convert(note.id, sel, to, {
      teamId,
      statusId: statuses[0]?.id,
      personId: note.personId,
    })
    if (!result.ok) { toast(result.reason ?? 'Could not convert that', true); return }
    toast(to === 'task' ? `Created ${result.label}` : 'Follow-up saved — it is on Today')
    setSel('')
  }

  return (
    <>
      <div className="topbar">
        <h1>Notes</h1>
        <button className={`chip btn-like${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>All</button>
        {NOTE_TYPES.map((t) => (
          <button key={t.value} className={`chip btn-like${filter === t.value ? ' on' : ''}`} onClick={() => setFilter(t.value)}>
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn primary" onClick={async () => {
          const n = await repo.create({ type: filter === 'all' ? 'meeting' : filter, teamId })
          setSelected(n.id)
        }}>New note</button>
      </div>

      <div className="notes-split">
        <div className="notes-list">
          {visible.length === 0 && <div className="small faint" style={{ padding: 14 }}>Nothing here yet.</div>}
          {visible.map((n) => (
            <button key={n.id} className={`note-row${n.id === selected ? ' on' : ''}`} onClick={() => setSelected(n.id)}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="chip">{labelOf(n.type)}</span>
                <span className="small faint">{formatDate(n.updatedAt)}</span>
                {n.isPrivate && <span className="chip solid">private</span>}
              </div>
              <b style={{ fontSize: 12.5, marginTop: 4, display: 'block' }}>{n.title}</b>
              <span className="small faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {n.body.split('\n')[0] || 'Empty'}
              </span>
            </button>
          ))}
        </div>

        <div className="notes-editor">
          {!note ? (
            <div className="empty"><strong>No note selected</strong>Pick one on the left, or start a new one.</div>
          ) : (
            <>
              <div className="topbar" style={{ borderTop: 0 }}>
                <select className="select" style={{ width: 130 }} value={note.type}
                  onChange={(e) => repo.update(note.id, { type: e.target.value as NoteType })}>
                  {NOTE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <select className="select" style={{ width: 150 }} value={note.personId ?? ''}
                  onChange={(e) => repo.update(note.id, { personId: e.target.value || null })}>
                  <option value="">Not about anyone</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <label className="small faint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={note.isPrivate} onChange={(e) => repo.update(note.id, { isPrivate: e.target.checked })} />
                  Private
                </label>
                <span className="spacer" />
                <button className="btn danger sm" onClick={async () => {
                  if (!confirm('Delete this note?')) return
                  await repo.remove(note.id); setSelected(null)
                }}>Delete</button>
              </div>

              <div className="notes-body">
                <input className="inline-input" style={{ fontSize: 19, fontWeight: 650, letterSpacing: '-.015em' }}
                  defaultValue={note.title} key={note.id}
                  onBlur={(e) => repo.update(note.id, { title: e.target.value })} />

                <textarea
                  ref={areaRef}
                  className="textarea note-area"
                  value={body}
                  placeholder={'Went well\n\nTo improve\n- Improve the QA handover process\n\nActions'}
                  onChange={(e) => editBody(e.target.value)}
                  onBlur={() => { void flush() }}
                  onSelect={captureSelection}
                  onKeyUp={captureSelection}
                  onMouseUp={captureSelection}
                />

                <div className={`convert-bar${sel ? ' on' : ''}`}>
                  {sel ? (
                    <>
                      <span className="small" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        “{sel}”
                      </span>
                      <button className="btn sm" onClick={() => convert('task')}>Make a task</button>
                      <button className="btn sm" onClick={() => convert('followUp')}>Make a follow-up</button>
                    </>
                  ) : (
                    <span className="small faint">Select a line above to turn it into a task or a follow-up.</span>
                  )}
                </div>

                {conversions.length > 0 && (
                  <div className="panel">
                    <p className="panel-title">Came out of this note</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {conversions.map((c) => {
                        if (c.createdType === 'task') {
                          const t = tasks.find((x) => x.id === c.createdId)
                          if (!t) return <div key={c.id} className="small faint">A task that has since been deleted</div>
                          return (
                            <button key={c.id} className="conv-row" onClick={() => setParam('task', t.id)}>
                              <Avatar person={t.assigneeId ? people.find((p) => p.id === t.assigneeId) ?? null : null} size={18} />
                              <span style={{ flex: 1, textAlign: 'left' }}>{t.title}</span>
                              <span className="chip">{t.key}</span>
                              <span className="chip">{statuses.find((s) => s.id === t.statusId)?.name}</span>
                            </button>
                          )
                        }
                        const f = follow.find((x) => x.id === c.createdId)
                        if (!f) return <div key={c.id} className="small faint">A follow-up that has since been deleted</div>
                        return (
                          <div key={c.id} className="conv-row" style={{ cursor: 'default' }}>
                            <span className="dot-ico" />
                            <span style={{ flex: 1 }}>{f.title}</span>
                            <span className="chip">{f.doneAt ? 'done' : 'follow-up'}</span>
                          </div>
                        )
                      })}
                    </div>
                    <p className="small faint" style={{ marginTop: 9, marginBottom: 0 }}>
                      Next retro, this is the list that tells the team whether the last one was worth attending.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
