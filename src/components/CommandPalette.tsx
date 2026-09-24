import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../db/schema'
import { go, setParam } from '../hooks/useRoute'
import { useTeamPeople } from '../hooks/useTeamPeople'
import { backup, blockers as blockerRepo, buildIndex, saveTextFile } from '../repo'
import { Avatar } from './Avatar'
import { useToast } from './Toast'

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  lead?: React.ReactNode
  run: () => void | Promise<void>
}

export function CommandPalette({
  teamId, onClose, onPaste,
}: { teamId: string; onClose: () => void; onPaste: () => void }) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const tasks = useLiveQuery(() => db.tasks.where('teamId').equals(teamId).toArray(), [teamId], [])
  const people = useTeamPeople(teamId)
  const statuses = useLiveQuery(() => db.statuses.orderBy('order').toArray(), [], [])
  const openBlockers = useLiveQuery(() => blockerRepo.listOpen(), [], [])
  const ix = buildIndex(statuses, people, openBlockers)

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase()
    const match = (s: string) => s.toLowerCase().includes(needle)

    const actions: Item[] = [
      { id: 'a-standup', group: 'Do', label: 'Run stand-up', run: () => go('standup') },
      { id: 'a-paste', group: 'Do', label: 'Add tasks from a pasted list', run: onPaste },
      {
        id: 'a-backup', group: 'Do', label: 'Export a backup',
        run: async () => {
          const text = JSON.stringify(await backup.snapshot(), null, 2)
          const ok = await saveTextFile(backup.filename(), text)
          toast(ok ? 'Backup saved' : 'Could not save here — use Settings', !ok)
        },
      },
      { id: 'g-today', group: 'Go to', label: 'Today', run: () => go('today') },
      { id: 'g-board', group: 'Go to', label: 'Board', run: () => go('board') },
      { id: 'g-person', group: 'Go to', label: 'Board grouped by person', run: () => go('board', { group: 'person' }) },
      { id: 'g-blockers', group: 'Go to', label: 'Blockers', run: () => go('blockers') },
      { id: 'g-sprints', group: 'Go to', label: 'Sprints', run: () => go('sprints') },
      { id: 'g-planning', group: 'Go to', label: 'Sprint planning', run: () => go('planning') },
      { id: 'g-people', group: 'Go to', label: 'People', run: () => go('people') },
      { id: 'g-settings', group: 'Go to', label: 'Settings', run: () => go('settings') },
    ].filter((a) => !needle || match(a.label))

    const taskHits: Item[] = (needle
      ? tasks.filter((t) => match(t.title) || match(t.key))
      : []
    ).slice(0, 8).map((t) => ({
      id: `t-${t.id}`,
      group: 'Tasks',
      label: t.title,
      hint: `${t.key} · ${ix.byStatus.get(t.statusId)?.name ?? ''}${ix.blockerByTask.has(t.id) ? ' · blocked' : ''}`,
      lead: <Avatar person={t.assigneeId ? ix.byPerson.get(t.assigneeId) ?? null : null} size={18} />,
      run: () => setParam('task', t.id),
    }))

    const peopleHits: Item[] = (needle ? people.filter((p) => match(p.name)) : [])
      .slice(0, 5).map((p) => ({
        id: `p-${p.id}`,
        group: 'People',
        label: p.name,
        hint: `${p.role} — show their board`,
        lead: <Avatar person={p} size={18} />,
        run: () => go('board', { person: p.id }),
      }))

    return [...actions, ...taskHits, ...peopleHits]
  }, [q, tasks, people, statuses, openBlockers])

  useEffect(() => { setCursor(0) }, [q])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[cursor]
        if (item) { void item.run(); onClose() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, cursor, onClose])

  useEffect(() => {
    listRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  let lastGroup = ''

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          value={q}
          placeholder="Search tasks and people, or jump somewhere"
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">Nothing matches that.</div>}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={`palette-item${i === cursor ? ' on' : ''}`}
                  data-on={i === cursor ? '1' : '0'}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => { void item.run(); onClose() }}
                >
                  {item.lead ?? <span className="dot-ico" />}
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">↑↓ move · ⏎ pick · esc close</div>
      </div>
    </>
  )
}
