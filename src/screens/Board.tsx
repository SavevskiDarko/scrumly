import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Avatar } from '../components/Avatar'
import { QuickAdd } from '../components/QuickAdd'
import { TaskCard, TaskFace } from '../components/TaskCard'
import { db } from '../db/schema'
import type { Person, Status, Task } from '../db/types'
import { go, setParam, useRoute } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import {
  blockers as blockerRepo, bucketOf, buildIndex, ownerFieldFor, ownerOf,
  sprints as sprintRepo, tasks as taskRepo, type BoardIndex, type Bucket,
} from '../repo'

const BUCKET_LABEL: Record<Bucket, string> = {
  blocked: 'blocked',
  stuck: 'sitting too long',
  overdue: 'past their due date',
  unowned: 'with no assignee',
}

const byOrder = (a: Task, b: Task) => a.orderInColumn - b.orderInColumn

function StatusColumn({
  status, items, total, people, teamId, ix, filtered, onOpen,
}: {
  status: Status; items: Task[]; total: number; people: Person[]; teamId: string
  ix: BoardIndex; filtered: boolean; onOpen: (id: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status.id}` })
  // Measured against everything in the column, not what a filter left visible:
  // a WIP limit that relaxes when you filter is worse than no WIP limit.
  const overLimit = status.wipLimit != null && total > status.wipLimit
  return (
    <div ref={setNodeRef} className={`column${isOver ? ' over' : ''}`}>
      <div className="col-head">
        <b>{status.name}</b>
        <span className="col-count">{filtered ? `${items.length} of ${total}` : total}</span>
        {overLimit && <span className="chip warn" style={{ padding: '0 7px' }}>over {status.wipLimit}</span>}
      </div>
      <div className="col-body">
        {items.map((t) => (
          <TaskCard key={t.id} task={t} status={status}
            owner={ownerOf(t, status, ix)}
            assignee={t.assigneeId ? ix.byPerson.get(t.assigneeId) ?? null : null}
            blocker={ix.blockerByTask.get(t.id) ?? null}
            onOpen={onOpen} />
        ))}
        {items.length === 0 && !filtered && <div className="small faint" style={{ padding: '6px 4px' }}>Nothing here</div>}
      </div>
      {!filtered && <QuickAdd teamId={teamId} statusId={status.id} people={people} />}
    </div>
  )
}

function Cell({
  personKey, status, items, ix, onOpen,
}: { personKey: string; status: Status; items: Task[]; ix: BoardIndex; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${personKey}:${status.id}` })
  return (
    <div ref={setNodeRef} className={`cell${isOver ? ' over' : ''}`}>
      {items.map((t) => (
        <TaskCard key={t.id} task={t} status={status} orderable={false}
          owner={ownerOf(t, status, ix)}
          blocker={ix.blockerByTask.get(t.id) ?? null}
          onOpen={onOpen} />
      ))}
    </div>
  )
}

export function Board({ teamId }: { teamId: string }) {
  const [dragging, setDragging] = useState<Task | null>(null)
  const route = useRoute()
  // Mouse and touch separately, because a whole card is the handle. A finger
  // on a card is usually the start of a scroll, so touch waits for a press and
  // hold, and a finger that moves first scrolls the board as it always did.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  )

  const bucket = route.params.get('filter') as Bucket | null
  const personId = route.params.get('person')
  const byPersonView = route.params.get('group') === 'person'

  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const people = useTeamPeople(teamId)
  const all = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])
  const sprintList = useLiveQuery(() => sprintRepo.listForTeam(teamId), [teamId], [])

  const ix = buildIndex(statuses, people, openBlockers)
  const sprintFilter = route.params.get('sprint')

  let visible = all
  if (sprintFilter) visible = visible.filter((t) => t.sprintId === sprintFilter)
  if (personId) visible = visible.filter((t) => t.assigneeId === personId || t.reviewerId === personId || t.testerId === personId)
  if (bucket && bucket in BUCKET_LABEL) visible = visible.filter((t) => bucketOf(t, ix)[bucket])
  // The sprint filter counts too. Leaving it out kept quick-add on screen while
  // filtered, so a task added there was created with no sprint and vanished as
  // soon as it was saved.
  const filtered = Boolean(personId || bucket || sprintFilter)

  function onStart(e: DragStartEvent) {
    setDragging(all.find((t) => t.id === String(e.active.id).slice(5)) ?? null)
  }

  async function onEnd(e: DragEndEvent) {
    setDragging(null)
    if (!e.over) return
    const activeId = String(e.active.id).slice(5)
    const overId = String(e.over.id)

    if (overId.startsWith('col:')) {
      await taskRepo.move(activeId, overId.slice(4), null)
      return
    }
    if (overId.startsWith('cell:')) {
      const [, personKey, statusId] = overId.split(':')
      const status = ix.byStatus.get(statusId)
      await taskRepo.move(activeId, statusId, null)
      // Dropping into someone's row assigns them in whichever field that column makes answerable.
      await taskRepo.setOwnerFor(activeId, ownerFieldFor(status), personKey === 'none' ? null : personKey)
      return
    }
    if (overId.startsWith('task:')) {
      const target = all.find((t) => t.id === overId.slice(5))
      if (!target || target.id === activeId) return
      await taskRepo.move(activeId, target.statusId, target.id)
    }
  }

  const rows: { key: string; person: Person | null }[] = [
    ...people.map((p) => ({ key: p.id, person: p })),
    { key: 'none', person: null },
  ]

  return (
    <>
      <div className="topbar">
        <h1>Board</h1>
        <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginLeft: 6 }}>
          {people.map((p) => (
            <button key={p.id} onClick={() => setParam('person', personId === p.id ? null : p.id)} title={`Only ${p.name}`}
              style={{
                background: 'none', border: 0, padding: 2, cursor: 'pointer', borderRadius: '50%',
                outline: personId === p.id ? '2px solid var(--accent)' : 'none',
                opacity: personId && personId !== p.id ? 0.4 : 1,
              }}>
              <Avatar person={p} size={22} />
            </button>
          ))}
        </div>
        <span className="spacer" />
        {sprintList.length > 0 && (
          <select className="select" style={{ width: 132 }} value={sprintFilter ?? ''}
            onChange={(e) => setParam('sprint', e.target.value || null)}>
            <option value="">All tasks</option>
            {sprintList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <div className="seg">
          <button className={!byPersonView ? 'on' : ''} onClick={() => setParam('group', null)}>Status</button>
          <button className={byPersonView ? 'on' : ''} onClick={() => setParam('group', 'person')}>Person</button>
        </div>
        <span className="small faint">{visible.length} of {all.length}</span>
      </div>

      {filtered && (
        <div className="filter-bar">
          <span>
            Showing tasks{bucket ? ` ${BUCKET_LABEL[bucket]}` : ''}
            {personId ? ` for ${ix.byPerson.get(personId)?.name ?? 'someone'}` : ''}
            {sprintFilter ? ` in ${sprintList.find((s) => s.id === sprintFilter)?.name ?? 'a sprint'}` : ''}
          </span>
          {visible.length === 0 && <span className="faint">— none right now</span>}
          <span className="spacer" />
          <button className="btn sm" onClick={() => go('board', byPersonView ? { group: 'person' } : {})}>Clear filter</button>
        </div>
      )}

      <div className="screen">
        {statuses.length === 0 ? (
          <div className="empty"><strong>No columns yet</strong>Add some in Settings.</div>
        ) : (
          <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
            {byPersonView ? (
              <div className="grid-board">
                <div className="grid-row head">
                  <div className="grid-label" />
                  {statuses.map((s) => <div key={s.id} className="grid-col-head">{s.name}</div>)}
                </div>
                {rows.map(({ key, person }) => {
                  const mine = visible.filter((t) => (ownerOf(t, ix.byStatus.get(t.statusId), ix)?.id ?? 'none') === key)
                  if (!person && mine.length === 0) return null
                  const activeCount = mine.filter((t) => ix.activeIds.has(t.statusId)).length
                  return (
                    <div key={key} className={`grid-row${person ? '' : ' unassigned'}`}>
                      <div className="grid-label">
                        <Avatar person={person} size={26} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {person?.name.split(' ')[0] ?? 'Unassigned'}
                          </div>
                          <div className="small faint">{activeCount} active</div>
                        </div>
                      </div>
                      {statuses.map((s) => (
                        <Cell key={s.id} personKey={key} status={s} ix={ix}
                          items={mine.filter((t) => t.statusId === s.id).sort(byOrder)}
                          onOpen={(id) => setParam('task', id)} />
                      ))}
                    </div>
                  )
                })}
                <p className="small faint" style={{ padding: '10px 16px 24px', margin: 0, maxWidth: '64ch' }}>
                  Dropping a card into someone's row makes them answerable for it — reviewer in a review column, tester in QA,
                  assignee everywhere else. The empty cells are the useful part.
                </p>
              </div>
            ) : (
              <div className="board">
                {statuses.map((s) => (
                  <StatusColumn key={s.id} status={s} teamId={teamId} people={people} ix={ix} filtered={filtered}
                    items={visible.filter((t) => t.statusId === s.id).sort(byOrder)}
                    total={all.filter((t) => t.statusId === s.id).length}
                    onOpen={(id) => setParam('task', id)} />
                ))}
              </div>
            )}
            <DragOverlay dropAnimation={null}>
              {dragging && (
                <div className="drag-ghost">
                  <TaskFace task={dragging} status={ix.byStatus.get(dragging.statusId)}
                    owner={ownerOf(dragging, ix.byStatus.get(dragging.statusId), ix)}
                    blocker={ix.blockerByTask.get(dragging.id) ?? null} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </>
  )
}
