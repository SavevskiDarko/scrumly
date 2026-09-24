import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../db/schema'
import type { ID, Priority } from '../db/types'
import { go, setParam } from '../hooks/useRoute'
import { usePickablePeople } from '../hooks/useTeamPeople'
import { formatDate } from '../lib/dates'
import { boards as boardRepo, daysInStatus, sprints as sprintRepo, tasks as taskRepo } from '../repo'
import { Avatar } from './Avatar'
import { BlockedPanel } from './BlockedPanel'
import { DateField } from './DateField'
import { DependencyPanel } from './DependencyPanel'
import { useToast } from './Toast'

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']

export function TaskDrawer({ taskId }: { taskId: ID }) {
  const toast = useToast()
  const task = useLiveQuery(() => db.tasks.get(taskId), [taskId])
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = usePickablePeople(task?.teamId ?? '', [task?.assigneeId ?? null, task?.reviewerId ?? null, task?.testerId ?? null])
  const history = useLiveQuery(() => taskRepo.history(taskId), [taskId], [])
  const diagrams = useLiveQuery(() => boardRepo.forEntity('task', taskId), [taskId], [])
  const sprintList = useLiveQuery(async () => (task ? await sprintRepo.listForTeam(task.teamId) : []), [task?.teamId], [])
  // Where "Open in Jira" points. Gone if the team stopped following its board.
  const jiraSite = useLiveQuery(
    async () => (task?.jira ? (await db.teams.get(task.teamId))?.jira?.site ?? null : null), [task?.teamId, task?.jira?.key], null,
  )
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')

  useEffect(() => {
    if (task) { setTitle(task.title); setDesc(task.description) }
  }, [task?.id])

  /**
   * Title and description save on blur, but Escape and the scrim unmount the
   * drawer without one, which used to throw the edit away. A ref keeps the
   * latest values reachable from handlers that were created before them.
   */
  const latest = useRef({ taskId, title, desc, savedTitle: '', savedDesc: '' })
  latest.current = {
    taskId,
    title,
    desc,
    savedTitle: task?.title ?? '',
    savedDesc: task?.description ?? '',
  }

  const commit = useCallback(async () => {
    const { taskId: id, title: t, desc: d, savedTitle, savedDesc } = latest.current
    const patch: { title?: string; description?: string } = {}
    if (t.trim() && t.trim() !== savedTitle) patch.title = t.trim()
    if (d !== savedDesc) patch.description = d
    if (Object.keys(patch).length) await taskRepo.update(id, patch)
  }, [])

  const close = useCallback(() => { void commit(); setParam('task', null) }, [commit])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Anything else that unmounts the drawer — a nav click, the palette — still
  // writes what was typed.
  useEffect(() => () => { void commit() }, [commit])

  if (!task) return null
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  const peopleById = new Map(people.map((p) => [p.id, p]))

  const personSelect = (field: 'assigneeId' | 'reviewerId' | 'testerId') => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <Avatar person={task[field] ? peopleById.get(task[field]!) ?? null : null} size={22} />
      <select
        className="select"
        value={task[field] ?? ''}
        onChange={(e) => taskRepo.update(task.id, { [field]: e.target.value || null })}
      >
        <option value="">Nobody</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  )

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label={task.key}>
        <div className="drawer-head">
          <span className="task-key">{task.key}</span>
          <span className="chip solid">{statusById.get(task.statusId)?.name ?? '—'}</span>
          <span className="small faint">{daysInStatus(task)}d here</span>
          <span className="spacer" />
          {task.jira && jiraSite && (
            <a className="btn ghost sm" href={`${jiraSite}/browse/${encodeURIComponent(task.jira.key)}`} target="_blank" rel="noreferrer">
              Open in Jira
            </a>
          )}
          <button className="btn ghost sm" onClick={close}>Close</button>
        </div>

        <div className="drawer-body">
          <input
            className="inline-input"
            style={{ fontSize: 17, fontWeight: 650, letterSpacing: '-.012em' }}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && taskRepo.update(task.id, { title: title.trim() })}
          />
          {task.jira && (
            <p className="small faint" style={{ margin: '-8px 0 0' }}>
              From Jira. Its title, status, sprint, assignee, size and dates come from there and are replaced on the
              next pull; reviewer, tester, blockers and dependencies are kept.
            </p>
          )}

          <BlockedPanel taskId={task.id} teamId={task.teamId} />

          <div className="field">
            <span className="label">Description</span>
            <textarea
              className="textarea"
              value={desc}
              placeholder="What needs doing, and anything the person picking it up would ask."
              onChange={(e) => setDesc(e.target.value)}
              onBlur={() => desc !== task.description && taskRepo.update(task.id, { description: desc })}
            />
          </div>

          <DependencyPanel task={task} />

          <div>
            <p className="panel-title">
              Diagrams
              <span className="spacer" />
              <button className="btn ghost sm" onClick={async () => {
                const b = await boardRepo.create(task.title)
                await boardRepo.link(b.id, 'task', task.id)
                setParam('task', null)
                go('canvas', { board: b.id })
              }}>New diagram from this task</button>
            </p>
            {diagrams.length === 0 ? (
              <p className="small faint" style={{ margin: 0 }}>
                Nothing attached. A diagram made here is linked, not copied — the same board can explain several tasks.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {diagrams.map((b) => (
                  <button key={b.id} className="diagram-row" onClick={() => { setParam('task', null); go('canvas', { board: b.id }) }}>
                    <span className="diagram-thumb">
                      {b.thumbnail ? <img src={b.thumbnail} alt="" /> : <span className="faint small">Empty</span>}
                    </span>
                    <span style={{ flex: 1, textAlign: 'left' }}>
                      <b style={{ fontSize: 12 }}>{b.title}</b>
                    </span>
                    <span className="btn sm">Open</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <hr className="hr" />

          <div className="meta-grid">
            <span className="label">Status</span>
            <select
              className="select"
              value={task.statusId}
              onChange={(e) => taskRepo.move(task.id, e.target.value, null)}
            >
              {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            <span className="label">Assignee</span>{personSelect('assigneeId')}
            <span className="label">Reviewer</span>{personSelect('reviewerId')}
            <span className="label">Tester</span>{personSelect('testerId')}

            <span className="label">Sprint</span>
            <select className="select" value={task.sprintId ?? ''} onChange={(e) => taskRepo.setSprint(task.id, e.target.value || null)}>
              <option value="">No sprint</option>
              {sprintList.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' — running' : ''}</option>)}
            </select>

            <span className="label">Priority</span>
            <select className="select" value={task.priority} onChange={(e) => taskRepo.update(task.id, { priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>

            <span className="label">Size</span>
            {/* Saves on blur: the burndown reads this, and a live field turned
                "12" into a 1-point task on the way to typing it. */}
            <input
              className="input" type="number" min={0} step={1} placeholder="points"
              key={`size-${task.id}`} defaultValue={task.size ?? ''}
              onBlur={(e) => {
                const raw = e.target.value.trim()
                const n = Number(raw)
                taskRepo.update(task.id, { size: raw && Number.isFinite(n) && n >= 0 ? n : null })
              }}
            />

            <span className="label">Due</span>
            {/* Clearable: a task losing its due date is a normal edit, unlike a
                sprint, which always has one. */}
            <DateField label="Due date" clearable value={task.dueDate ?? null}
              onCommit={(iso) => void taskRepo.update(task.id, { dueDate: iso })} />

            <span className="label">Project</span>
            <input className="input" placeholder="Optional label" key={`project-${task.id}`} defaultValue={task.project ?? ''}
              onBlur={(e) => taskRepo.update(task.id, { project: e.target.value.trim() || null })} />

            <span className="label">Tags</span>
            <input
              className="input" placeholder="backend, vendor"
              defaultValue={task.tags.join(', ')}
              onBlur={(e) => taskRepo.update(task.id, { tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </div>

          <hr className="hr" />

          <div>
            <p className="panel-title">History</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.map((h) => (
                <div key={h.id} className="small muted" style={{ display: 'flex', gap: 8 }}>
                  {/* Wide enough for a full dd/mm/yyyy, so the event text beside
                      it starts in the same place on every row. */}
                  <span className="faint" style={{ width: 72, flex: 'none' }}>{formatDate(h.at)}</span>
                  <span>
                    {h.fromStatusId
                      ? `${statusById.get(h.fromStatusId)?.name ?? '?'} → ${statusById.get(h.toStatusId)?.name ?? '?'}`
                      : `Created in ${statusById.get(h.toStatusId)?.name ?? '?'}`}
                  </span>
                </div>
              ))}
            </div>
            <p className="small faint" style={{ marginTop: 10, marginBottom: 0 }}>
              Every move is recorded here from the first version. Stuck lists, carry-over and the burndown chart are all read back out of it later.
            </p>
          </div>

          <div style={{ marginTop: 'auto', paddingTop: 8 }}>
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm(`Delete ${task.key}? This also removes its history and cannot be undone.`)) return
                await taskRepo.remove(task.id)
                setParam('task', null)
                toast(`${task.key} deleted`)
              }}
            >
              Delete task
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
