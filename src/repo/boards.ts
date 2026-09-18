import { db } from '../db/schema'
import type { Board, BoardLink, ID } from '../db/types'
import { newId } from './ids'

export type EntityType = BoardLink['entityType']

export const boards = {
  list: () => db.boards.orderBy('updatedAt').reverse().toArray(),
  get: (id: ID) => db.boards.get(id),

  async create(title = 'Untitled diagram'): Promise<Board> {
    const now = Date.now()
    const row: Board = {
      id: newId(),
      title: title.trim() || 'Untitled diagram',
      scene: [],
      appState: {},
      thumbnail: null,
      createdAt: now,
      updatedAt: now,
    }
    await db.boards.add(row)
    return row
  },

  async save(id: ID, scene: unknown, appState: unknown) {
    await db.boards.update(id, { scene, appState, updatedAt: Date.now() })
  },

  async setThumbnail(id: ID, thumbnail: string | null) {
    await db.boards.update(id, { thumbnail })
  },

  rename: (id: ID, title: string) => db.boards.update(id, { title: title.trim() || 'Untitled diagram' }),

  async remove(id: ID) {
    await db.transaction('rw', db.boards, db.boardLinks, async () => {
      await db.boards.delete(id)
      await db.boardLinks.where('boardId').equals(id).delete()
    })
  },

  /** A board is referenced from many places and never copied into them. */
  async link(boardId: ID, entityType: EntityType, entityId: ID) {
    const existing = await db.boardLinks
      .where('boardId').equals(boardId)
      .filter((l) => l.entityType === entityType && l.entityId === entityId)
      .first()
    if (existing) return existing
    const row: BoardLink = { id: newId(), boardId, entityType, entityId }
    await db.boardLinks.add(row)
    return row
  },

  unlink: (linkId: ID) => db.boardLinks.delete(linkId),
  linksFor: (boardId: ID) => db.boardLinks.where('boardId').equals(boardId).toArray(),

  async forEntity(entityType: EntityType, entityId: ID): Promise<Board[]> {
    const links = await db.boardLinks.where('entityId').equals(entityId)
      .filter((l) => l.entityType === entityType).toArray()
    const rows = await Promise.all(links.map((l) => db.boards.get(l.boardId)))
    return rows.filter((b): b is Board => Boolean(b))
  },
}
