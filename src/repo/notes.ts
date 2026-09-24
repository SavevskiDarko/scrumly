import { db } from '../db/schema'
import type { Conversion, FollowUp, ID, Note, NoteType, Sprint, Task } from '../db/types'
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
   * The retro before this one, for the same team. A new retro opens with what
   * happened to that one's actions, which is the only honest answer to "was
   * the last one worth having".
   */
  async previousRetro(note: Note): Promise<Note | null> {
    const retros = await db.notes.where('type').equals('retro').toArray()
    const earlier = retros
      .filter((n) => n.id !== note.id && n.teamId === note.teamId && n.createdAt < note.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt)
    return earlier[0] ?? null
  },

  /** One retro per sprint: found again if it exists, made if it does not. */
  async retroFor(teamId: ID, sprint: Sprint): Promise<Note> {
    const existing = await db.notes.where('sprintId').equals(sprint.id)
      .filter((n) => n.type === 'retro' && n.teamId === teamId)
      .first()
    if (existing) return existing
    return notes.create({ type: 'retro', teamId, sprintId: sprint.id, title: `${sprint.name} retrospective` })
  },

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

export interface ActionOutcome {
  conversionId: ID
  kind: 'task' | 'followUp'
  targetId: ID
  title: string
  done: boolean
  /** Deleted since. Counted, because an action that vanished did not land either. */
  gone: boolean
  statusId: ID | null
}

/** What each thing a note turned into has come to. Open ones first — they are the agenda. */
export function actionOutcomes(
  conversions: Conversion[],
  tasks: Task[],
  follow: FollowUp[],
  doneIds: Set<ID>,
): ActionOutcome[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const fuById = new Map(follow.map((f) => [f.id, f]))
  const rank = (o: ActionOutcome) => (o.done ? 2 : o.gone ? 1 : 0)
  return conversions
    .map((c): ActionOutcome => {
      if (c.createdType === 'task') {
        const t = taskById.get(c.createdId)
        return {
          conversionId: c.id, kind: 'task', targetId: c.createdId,
          title: t?.title ?? 'A task that has since been deleted',
          done: t ? doneIds.has(t.statusId) : false,
          gone: !t,
          statusId: t?.statusId ?? null,
        }
      }
      const f = fuById.get(c.createdId)
      return {
        conversionId: c.id, kind: 'followUp', targetId: c.createdId,
        title: f?.title ?? 'A follow-up that has since been deleted',
        done: Boolean(f?.doneAt),
        gone: !f,
        statusId: null,
      }
    })
    .sort((a, b) => rank(a) - rank(b))
}
