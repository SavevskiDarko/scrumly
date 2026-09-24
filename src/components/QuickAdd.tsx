import { useState } from 'react'
import type { Person } from '../db/types'
import { parseQuickAdd, tasks } from '../repo'

export function QuickAdd({
  teamId, statusId, people, sprintId = null, onDone,
}: { teamId: string; statusId: string; people: Person[]; sprintId?: string | null; onDone?: () => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  async function submit(keepOpen: boolean) {
    const parsed = parseQuickAdd(value)
    if (!parsed.title) return
    const match = parsed.assigneeName
      ? people.find((p) => p.name.toLowerCase().startsWith(parsed.assigneeName!.toLowerCase()))
      : undefined
    const task = await tasks.create({
      teamId,
      statusId,
      title: parsed.title,
      assigneeId: match?.id ?? null,
      priority: parsed.priority ?? 'normal',
      size: parsed.size,
      tags: parsed.tags,
    })
    // Through setSprint rather than create, so the join is logged like any other.
    if (sprintId) await tasks.setSprint(task.id, sprintId)
    setValue('')
    if (!keepOpen) { setOpen(false); onDone?.() }
  }

  if (!open) {
    return <button className="add-row" onClick={() => setOpen(true)}>+ Add a task</button>
  }

  return (
    <div className="add-open">
      <input
        className="input"
        autoFocus
        value={value}
        placeholder="Seed refund accounts @nadica !high ~3 #qa"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit(true) }
          if (e.key === 'Escape') { setOpen(false); setValue('') }
        }}
        onBlur={() => { if (!value.trim()) setOpen(false) }}
      />
      <div className="hint">@person · !high · ~3 points · #tag — Enter adds and stays open</div>
    </div>
  )
}
