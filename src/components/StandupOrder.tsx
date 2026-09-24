import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Person } from '../db/types'
import { Avatar } from './Avatar'

/**
 * Arranging who speaks when.
 *
 * Stand-ups have an order whether anybody chose it or not, and the one the app
 * picked — alphabetical, rotated by the day — is rarely the one a team wants.
 * People who hand over to each other should be adjacent, whoever has to leave
 * early should be early, and the person who always talks longest should not be
 * the reason the last three are rushed.
 *
 * Drag to rearrange, or use the arrows. The arrows are not a fallback: a
 * pointer drag is awkward on a phone, and this is a screen people open two
 * minutes before a meeting starts.
 */

function Row({ person, index, count, onMove }: {
  person: Person
  index: number
  count: number
  onMove: (from: number, to: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: person.id })

  return (
    <div
      ref={setNodeRef}
      className="standup-order-row"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <span className="standup-order-grip" {...attributes} {...listeners} aria-label={`Drag ${person.name}`}>⠿</span>
      <span className="small faint" style={{ width: 16, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span>
      <Avatar person={person} size={24} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {person.name}
      </span>
      <span className="small faint" style={{ flex: 'none' }}>{person.role}</span>
      <button
        className="btn ghost sm" style={{ flex: 'none', padding: '0 6px' }}
        aria-label={`Move ${person.name} earlier`} disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
      >↑</button>
      <button
        className="btn ghost sm" style={{ flex: 'none', padding: '0 6px' }}
        aria-label={`Move ${person.name} later`} disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >↓</button>
    </div>
  )
}

export function StandupOrder({ order, people, onReorder }: {
  /** Person ids, in running order. */
  order: string[]
  people: Person[]
  onReorder: (next: string[]) => void
}) {
  // Same activation distance as the board, so a drag feels the same in both.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const rows = order
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is Person => Boolean(p))

  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to) return
    const next = [...order]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    move(order.indexOf(String(active.id)), order.indexOf(String(over.id)))
  }

  if (rows.length === 0) return null

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <div className="standup-order">
          {rows.map((p, i) => (
            <Row key={p.id} person={p} index={i} count={rows.length} onMove={move} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
