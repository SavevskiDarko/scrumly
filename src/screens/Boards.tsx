import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'
import { go } from '../hooks/useRoute'
import { boards as boardRepo } from '../repo'

function when(ts: number) {
  const d = Math.floor((Date.now() - ts) / 86_400_000)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function Boards() {
  const rows = useLiveQuery(() => boardRepo.list(), [], [])
  const links = useLiveQuery(() => db.boardLinks.toArray(), [], [])
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], [])

  return (
    <>
      <div className="topbar">
        <h1>Boards</h1>
        <span className="chip solid">{rows.length}</span>
        <span className="spacer" />
        <button className="btn primary" onClick={async () => {
          const b = await boardRepo.create()
          go('canvas', { board: b.id })
        }}>New board</button>
      </div>

      <div className="screen pad">
        {rows.length === 0 ? (
          <div className="empty">
            <strong>No diagrams yet</strong>
            A board is a document you can attach to as many tasks as you like. It is never copied — edit it once and
            everywhere pointing at it shows the change.
          </div>
        ) : (
          <div className="board-grid">
            {rows.map((b) => {
              const keys = links.filter((l) => l.boardId === b.id && l.entityType === 'task')
                .map((l) => tasks.find((t) => t.id === l.entityId)?.key)
                .filter(Boolean)
              return (
                <button key={b.id} className="board-tile" onClick={() => go('canvas', { board: b.id })}>
                  <div className="board-thumb">
                    {b.thumbnail
                      ? <img src={b.thumbnail} alt="" />
                      : <span className="faint small">Empty</span>}
                  </div>
                  <div className="board-meta">
                    <b>{b.title}</b>
                    <span className="small faint">
                      {keys.length ? `${keys.slice(0, 3).join(', ')} · ` : ''}edited {when(b.updatedAt)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
