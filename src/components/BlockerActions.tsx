import { useState } from 'react'
import type { ID } from '../db/types'
import { blockers as repo } from '../repo'
import { useToast } from './Toast'

/*
 * Chase and Unblock, for the task's blocked panel and the Blockers screen
 * alike. Both stay one click: a note is something you can add, never something
 * you are asked for. Note… swaps the buttons for a box to type it in, with the
 * same two buttons beside it, so a note only ever goes with the button pressed
 * next to it.
 */

export function BlockerButtons({ blockerId, onNote }: { blockerId: ID; onNote: () => void }) {
  const toast = useToast()
  return (
    <>
      <button className="btn sm" onClick={async () => { await repo.chase(blockerId); toast('Chase logged') }}>Chase</button>
      <button className="btn sm" onClick={async () => { await repo.resolve(blockerId); toast('Unblocked') }}>Unblock</button>
      <button className="btn ghost sm" title="Chase or unblock with a note" onClick={onNote}>Note…</button>
    </>
  )
}

export function BlockerNote({ blockerId, onDone }: { blockerId: ID; onDone: () => void }) {
  const toast = useToast()
  const [note, setNote] = useState('')

  // Closed before the write lands, so a second click has nothing to land on
  // and cannot log the same chase twice.
  async function act(kind: 'chase' | 'resolve') {
    onDone()
    if (kind === 'chase') { await repo.chase(blockerId, note); toast('Chase logged') }
    else { await repo.resolve(blockerId, note); toast('Unblocked') }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0 }}>
      <input
        className="input" autoFocus style={{ flex: 1, minWidth: 0 }}
        placeholder="Who you chased and how, or what cleared it"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        // Closes the note, not the drawer around it.
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone() } }}
      />
      <button className="btn sm" onClick={() => void act('chase')}>Chase</button>
      <button className="btn sm" onClick={() => void act('resolve')}>Unblock</button>
      <button className="btn ghost sm" onClick={onDone}>Cancel</button>
    </div>
  )
}
