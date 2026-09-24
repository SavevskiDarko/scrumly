import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import type { Conversion, FollowUp, Note, NoteType, Sprint, Status, Task } from '../db/types'
import { setParam, useRoute } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import {
  NOTE_TYPES, actionOutcomes, followUps as fuRepo, notes as repo, sprints as sprintRepo, todayISO,
} from '../repo'

function when(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const labelOf = (t: NoteType) => NOTE_TYPES.find((x) => x.value === t)?.label ?? t

/**
 * Retros happen at the edge of a sprint — the last afternoon of one, or the
 * first morning of the next — so the sprint a new retro is about is whichever
 * started sprint ends closest to today, not simply the one running.
 */
function retroSprint(sprints: Sprint[]): Sprint | null {
  const today = new Date(`${todayISO()}T12:00:00`).getTime()
  const distance = (s: Sprint) => Math.abs(new Date(`${s.endDate}T12:00:00`).getTime() - today)
  const started = sprints.filter((s) => s.state !== 'planned')
  return started.sort((a, b) => distance(a) - distance(b) || b.endDate.localeCompare(a.endDate))[0] ?? null
}

/**
 * What happened to the previous retro's actions, at the top of this one. The
 * conversions were always recorded; they were only ever visible from inside
 * the old note, which is the one place nobody looks during the next retro.
 */
function LastRetro({ note, tasks, follow, statuses, onOpenNote }: {
  note: Note; tasks: Task[]; follow: FollowUp[]; statuses: Status[]; onOpenNote: (id: string) => void
}) {
  const prev = useLiveQuery(() => repo.previousRetro(note), [note.id, note.teamId, note.createdAt])
  const conversions = useLiveQuery(
    async () => (prev ? repo.conversionsFor(prev.id) : [] as Conversion[]),
    [prev?.id], [] as Conversion[],
  )

  if (prev === undefined) return null
  if (prev === null) {
    return (
      <p className="small faint" style={{ margin: 0 }}>
        The first retro for this team. Next time, the actions that come out of this one are waiting here to be checked.
      </p>
    )
  }

  const doneIds = new Set(statuses.filter((s) => s.isDone).map((s) => s.id))
  const statusName = new Map(statuses.map((s) => [s.id, s.name]))
  const keyOf = new Map(tasks.map((t) => [t.id, t.key]))
  const outcomes = actionOutcomes(conversions, tasks, follow, doneIds)
  const done = outcomes.filter((o) => o.done).length
  const open = outcomes.filter((o) => !o.done && !o.gone).length
  const gone = outcomes.filter((o) => o.gone).length

  let verdict: string
  if (outcomes.length === 0) {
    verdict = 'The last retro turned nothing into an action, so there is nothing to check. Select a line below and '
      + 'make it a task or a follow-up — this is the list the next retro opens with.'
  } else if (open === 0) {
    verdict = gone
      ? `Everything still around landed; ${gone} ${gone === 1 ? 'was' : 'were'} deleted rather than done.`
      : 'Everything from last time landed. Worth saying so in the room.'
  } else {
    verdict = `${open} still open. Start here, before collecting anything new — a retro whose actions never land `
      + 'stops being worth attending.'
  }

  return (
    <div className="panel" style={{ borderColor: open ? 'var(--alert)' : undefined }}>
      <p className="panel-title">
        Since the last retro
        <span className="spacer" />
        {outcomes.length > 0 && (
          <span className={`chip${open ? ' warn' : ' on'}`} style={{ fontWeight: 600 }}>{done} of {outcomes.length} done</span>
        )}
      </p>
      <div style={{ marginBottom: outcomes.length ? 9 : 0 }}>
        <button className="linkish small" style={{ fontWeight: 500 }} onClick={() => onOpenNote(prev.id)}>{prev.title}</button>
        <span className="small faint"> · {when(prev.createdAt)}</span>
      </div>
      {outcomes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {outcomes.map((o) => {
            if (o.gone) {
              return (
                <div key={o.conversionId} className="conv-row done" style={{ cursor: 'default' }}>
                  <span className="dot-ico" />
                  <span style={{ flex: 1 }}>{o.title}</span>
                  <span className="chip">deleted</span>
                </div>
              )
            }
            if (o.kind === 'task') {
              return (
                <button key={o.conversionId} className={`conv-row${o.done ? ' done' : ''}`} onClick={() => setParam('task', o.targetId)}>
                  <span className="dot-ico" style={o.done ? { background: 'var(--ok)' } : undefined} />
                  <span style={{ flex: 1, textAlign: 'left' }}>{o.title}</span>
                  <span className="chip">{keyOf.get(o.targetId)}</span>
                  <span className={`chip${o.done ? ' solid' : ''}`}>{o.statusId ? statusName.get(o.statusId) : ''}</span>
                </button>
              )
            }
            return (
              <label key={o.conversionId} className={`conv-row${o.done ? ' done' : ''}`}>
                <input type="checkbox" checked={o.done} title={o.done ? 'Put it back on your list' : 'Done'}
                  onChange={() => void (o.done ? fuRepo.reopen(o.targetId) : fuRepo.complete(o.targetId))} />
                <span style={{ flex: 1 }}>{o.title}</span>
                <span className="chip">{o.done ? 'done' : 'your follow-up'}</span>
              </label>
            )
          })}
        </div>
      )}
      <p className="small faint" style={{ marginTop: 9, marginBottom: 0 }}>{verdict}</p>
    </div>
  )
}

export function Notes({ teamId }: { teamId: string }) {
  const toast = useToast()
  const route = useRoute()
  const wanted = route.params.get('note')
  const [selected, setSelected] = useState<string | null>(wanted)
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
  const teamSprints = useLiveQuery(() => sprintRepo.listForTeam(teamId), [teamId], [] as Sprint[])

  const mine = rows.filter((n) => n.teamId === teamId || n.teamId === null)
  const visible = filter === 'all' ? mine : mine.filter((n) => n.type === filter)

  // Arriving from a sprint's Retro button names the note to open.
  useEffect(() => { if (wanted) { setSelected(wanted); setFilter('all') } }, [wanted])
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
          const type = filter === 'all' ? 'meeting' : filter
          const sprint = type === 'retro' ? retroSprint(teamSprints) : null
          if (!sprint) {
            const n = await repo.create({ type, teamId })
            setSelected(n.id)
            return
          }
          // One retro per sprint: a second click finds the first rather than splitting it in two.
          const n = await repo.retroFor(teamId, sprint)
          if (rows.some((r) => r.id === n.id)) toast(`${sprint.name} already has a retro — opened it`)
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
                <span className="small faint">{when(n.updatedAt)}</span>
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
                {note.type === 'retro' && (
                  <select className="select" style={{ width: 140 }} value={note.sprintId ?? ''} title="Which sprint this retro is about"
                    onChange={(e) => repo.update(note.id, { sprintId: e.target.value || null })}>
                    <option value="">No sprint</option>
                    {[...teamSprints].reverse().map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                )}
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

                {note.type === 'retro' && (
                  <LastRetro note={note} tasks={tasks} follow={follow} statuses={statuses} onOpenNote={setSelected} />
                )}

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
