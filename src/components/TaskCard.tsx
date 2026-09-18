import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useRef } from 'react'
import type { Blocker, Person, Status, Task } from '../db/types'
import { blockedDays, daysInStatus, isStuck } from '../repo'
import { Avatar } from './Avatar'

export function TaskFace({
  task, owner, assignee, status, blocker,
}: {
  task: Task; owner?: Person | null; assignee?: Person | null
  status?: Status; blocker?: Blocker | null
}) {
  const days = daysInStatus(task)
  const stuck = isStuck(task, status?.stuckAfterDays ?? null)
  const showSecond = assignee && owner && assignee.id !== owner.id
  return (
    <>
      <div className="task-top">
        <span className="task-key">{task.key}</span>
        <span className="spacer" />
        {blocker && <span className="chip warn" style={{ padding: '0 7px' }}>Blocked {blockedDays(blocker)}d</span>}
        {!blocker && task.size != null && <span className="age">{task.size}p</span>}
      </div>
      <div className="task-title">{task.title}</div>
      <div className="task-foot">
        <Avatar person={owner} size={20} />
        {showSecond && <span style={{ marginLeft: -7 }}><Avatar person={assignee} size={20} dim /></span>}
        <span className="spacer" />
        {task.tags.slice(0, 1).map((t) => <span key={t} className="age">#{t}</span>)}
        {days > 0 && <span className={`age${stuck ? ' stuck' : ''}`}>{days}d</span>}
        <span className={`prio ${task.priority}`} title={`Priority: ${task.priority}`} />
      </div>
    </>
  )
}

export function TaskCard(props: {
  task: Task
  owner?: Person | null
  assignee?: Person | null
  status?: Status
  blocker?: Blocker | null
  /** False on the person-grouped board, where drops belong to the cell rather than the card. */
  orderable?: boolean
  onOpen: (id: string) => void
}) {
  const { task, orderable = true } = props
  const drag = useDraggable({ id: `task:${task.id}` })
  const drop = useDroppable({ id: `task:${task.id}`, disabled: !orderable })
  // A drag ends with a click on the card, which used to open the drawer every
  // time you moved something. Anything past the sensor's threshold was a drag.
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const wasDragged = (e: React.MouseEvent) => {
    const from = downAt.current
    downAt.current = null
    return !!from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4
  }

  const setRef = (node: HTMLElement | null) => {
    drag.setNodeRef(node)
    drop.setNodeRef(node)
  }

  const isTarget = drop.isOver && drag.active && String(drag.active.id) !== `task:${task.id}`

  return (
    <div
      ref={setRef}
      className={`task${drag.isDragging ? ' dragging' : ''}${isTarget ? ' drop-target' : ''}${props.blocker ? ' blocked' : ''}`}
      {...drag.listeners}
      {...drag.attributes}
      onPointerDownCapture={(e) => { downAt.current = { x: e.clientX, y: e.clientY } }}
      onClick={(e) => { if (!wasDragged(e)) props.onOpen(task.id) }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') props.onOpen(task.id) }}
    >
      <TaskFace {...props} />
    </div>
  )
}
