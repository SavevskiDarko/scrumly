import { db } from '../db/schema'
import type { Conversion, ID, Note, NoteType } from '../db/types'
import { followUps } from './followUps'
import { newId } from './ids'
import { tasks } from './tasks'

export const NOTE_TYPES: { value: NoteType; label: string }[] = [
  { value: 'retro', label: 'Retro' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'oneToOne', label: 'One-to-one' },
  { value: 'idea', label: 'Idea' },
  { value: 'improvement', label: 'Improvement' },
]

export const notes = {
  list: () => db.notes.orderBy('updatedAt').reverse().toArray(),
  get: (id: ID) => db.notes.get(id),

  async create(input: { type?: NoteType; title?: string; personId?: ID | null; sprintId?: ID | null; teamId?: ID | null }) {
    const now = Date.now()
    const row: Note = {
      id: newId(),
      type: input.type ?? 'meeting',
      title: input.title?.trim() || 'Untitled note',
      body: '',
      personId: input.personId ?? null,
      sprintId: input.sprintId ?? null,
      teamId: input.teamId ?? null,
      isPrivate: input.type === 'oneToOne',
      createdAt: now,
      updatedAt: now,
    }
    await db.notes.add(row)
    return row
  },

  update: (id: ID, patch: Partial<Omit<Note, 'id' | 'createdAt'>>) =>
    db.notes.update(id, { ...patch, updatedAt: Date.now() }),

  remove: (id: ID) =>
    db.transaction('rw', db.notes, db.conversions, async () => {
      await db.notes.delete(id)
      await db.conversions.where('noteId').equals(id).delete()
    }),

  conversionsFor: (noteId: ID) => db.conversions.where('noteId').equals(noteId).toArray(),

  /**
   * A retro line becomes either a task for a developer or a follow-up for you.
   * Sending both into the backlog is how retro actions die, so the choice is
   * forced at the point of conversion — and the link back is kept, so next
   * retro can show what happened to last retro's list.
   */
  async convert(
    noteId: ID,
    text: string,
    to: 'task' | 'followUp',
    extra: { teamId?: ID; statusId?: ID; assigneeId?: ID | null; personId?: ID | null } = {},
  ): Promise<{ ok: boolean; id?: ID; label?: string; reason?: string }> {
    const title = text.trim().replace(/^[-*•\s]+/, '')
    if (!title) return { ok: false, reason: 'Nothing selected' }

    let createdId: ID
    let label: string
    if (to === 'task') {
      if (!extra.teamId || !extra.statusId) return { ok: false, reason: 'No board to put it on' }
      const task = await tasks.create({
        teamId: extra.teamId, statusId: extra.statusId, title, assigneeId: extra.assigneeId ?? null,
      })
      createdId = task.id
      label = task.key
    } else {
      const fu = await followUps.create({ title, personId: extra.personId ?? null })
      await db.followUps.update(fu.id, { sourceNoteId: noteId })
      createdId = fu.id
      label = 'follow-up'
    }

    const conversion: Conversion = { id: newId(), noteId, createdType: to, createdId, at: Date.now() }
    await db.conversions.add(conversion)
    return { ok: true, id: createdId, label }
  },
}
