import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { db } from '../db/schema'
import { go } from '../hooks/useRoute'
import { settings as settingsRepo } from '../repo'
import { useAssistant } from './AssistantProvider'
import type { Conversation, Item } from './conversation'
import { Inline, KEY_PATTERN, Markdown, type KeyLinks } from './Markdown'
import { sharedWithAssistant } from './sight'

/** One click away from the questions a Scrum Master asks most days. */
const STARTERS: { label: string; prompt: string }[] = [
  { label: 'Plan my day', prompt: 'What should I focus on today? Look at blockers, stuck and overdue work, my follow-ups and the sprint, and give me a short list in the order I should tackle it.' },
  { label: 'How is the sprint going?', prompt: 'How is the running sprint going? Are we on track for the goal, and what is most at risk?' },
  { label: 'Prepare stand-up', prompt: 'Help me prepare today\'s stand-up: what has moved since the last one, what to ask each person, and anything blocked or stuck.' },
  { label: 'Who should I chase?', prompt: 'Which blockers should I chase today, with whom, and what should I say to each?' },
  { label: 'Plan the next sprint', prompt: 'Help me plan the next sprint: based on velocity, carry-over and priorities, what should go in it?' },
  { label: 'Retro talking points', prompt: 'Draft talking points for the retro from this sprint\'s data: what went well, what slowed us down, blockers, scope change and carry-over.' },
]

function useKeyLinks(items: Item[]): KeyLinks {
  const keys = useMemo(() => {
    const found = new Set<string>()
    for (const it of items) {
      const text = it.kind === 'assistant' ? it.text
        : it.kind === 'proposal' ? [it.title, ...it.lines].join('\n')
          : ''
      for (const m of text.matchAll(KEY_PATTERN)) found.add(m[0])
    }
    return [...found].sort()
  }, [items])
  return useLiveQuery(
    async () => new Map((await db.tasks.where('key').anyOf(keys).toArray()).map((t) => [t.key, t.id])),
    [keys.join(',')],
    new Map<string, string>(),
  )
}

function Proposal({ item, conversation, keys }: { item: Extract<Item, { kind: 'proposal' }>; conversation: Conversation; keys: KeyLinks }) {
  const settled = item.state === 'applied' || item.state === 'skipped' || item.state === 'failed'
  return (
    <div className={`assist-proposal ${item.state}`}>
      <div className="assist-proposal-kicker">
        {item.state === 'pending' ? 'Proposed change' : item.state === 'applying' ? 'Applying…'
          : item.state === 'applied' ? 'Applied' : item.state === 'skipped' ? 'Skipped' : 'Could not apply'}
      </div>
      <div className="assist-proposal-title"><Inline text={item.title} keys={keys} /></div>
      {item.lines.length > 0 && (
        <ul className="assist-proposal-lines">
          {item.lines.map((l, i) => <li key={i}><Inline text={l} keys={keys} /></li>)}
        </ul>
      )}
      {item.body && <div className="assist-proposal-body">{item.body}</div>}
      {item.state === 'pending' && (
        <div className="assist-proposal-actions">
          <button className="btn primary sm" onClick={() => void conversation.decide(item.id, 'apply')}>Apply</button>
          <button className="btn sm" onClick={() => void conversation.decide(item.id, 'skip')}>Skip</button>
        </div>
      )}
      {settled && item.outcome && <div className="assist-proposal-outcome"><Inline text={item.outcome} keys={keys} /></div>}
    </div>
  )
}

function Thread({ conversation }: { conversation: Conversation }) {
  const view = useSyncExternalStore(conversation.subscribe, conversation.get)
  const keys = useKeyLinks(view.items)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const pending = view.items.filter((i) => i.kind === 'proposal' && i.state === 'pending').length

  // Follows new text down, unless the user has scrolled up to read something.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [view])

  useEffect(() => { input.current?.focus() }, [])

  function submit(text = draft) {
    if (!text.trim() || view.phase !== 'idle') return
    stick.current = true
    setDraft('')
    void conversation.send(text)
  }

  const last = view.items[view.items.length - 1]
  const quiet = view.phase === 'thinking' && !(last?.kind === 'assistant' && last.text)

  return (
    <>
      <div
        className="assist-thread" ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {view.items.length === 0 && (
          <div className="assist-empty">
            <p className="muted" style={{ marginTop: 0 }}>
              Ask about your day, your sprint or your team. The assistant reads the open team's board, sprints, blockers,
              stand-up notes and your follow-ups. It can propose changes, but nothing happens until you click Apply.
            </p>
            <div className="assist-starters">
              {STARTERS.map((s) => (
                <button key={s.label} className="chip btn-like" onClick={() => submit(s.prompt)}>{s.label}</button>
              ))}
            </div>
          </div>
        )}

        {view.items.map((item) => {
          switch (item.kind) {
            case 'user':
              return <div key={item.id} className="assist-user">{item.text}</div>
            case 'assistant':
              if (!item.text) return null
              return (
                <div key={item.id} className={`assist-reply${item.live ? ' live' : ''}`}>
                  <Markdown text={item.text} keys={keys} />
                </div>
              )
            case 'activity':
              return <div key={item.id} className="assist-activity">{item.text}</div>
            case 'proposal':
              return <Proposal key={item.id} item={item} conversation={conversation} keys={keys} />
            case 'notice':
              return <div key={item.id} className={`assist-notice ${item.tone}`}>{item.text}</div>
          }
        })}

        {quiet && <div className="assist-activity assist-thinking">Thinking…</div>}
      </div>

      <div className="assist-foot">
        {pending > 1 && (
          <div className="assist-all">
            <span className="small muted">{pending} changes waiting</span>
            <span className="spacer" />
            <button className="btn primary sm" onClick={() => void conversation.decideAll('apply')}>Apply all</button>
            <button className="btn sm" onClick={() => void conversation.decideAll('skip')}>Skip all</button>
          </div>
        )}
        <div className="assist-compose">
          <textarea
            ref={input}
            className="textarea assist-input"
            rows={2}
            placeholder={view.phase === 'waiting' ? 'Apply or skip the changes above to carry on…' : 'Ask the assistant…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            }}
          />
          {view.phase === 'idle'
            ? <button className="btn primary" disabled={!draft.trim()} onClick={() => submit()}>Send</button>
            : <button className="btn" onClick={() => conversation.stop()}>Stop</button>}
        </div>
      </div>
    </>
  )
}

/** Beside the screen rather than over it, so the board stays in view while you talk about it. */
export function AssistantPanel() {
  const { conversation, connection, open, setOpen } = useAssistant()
  const team = useLiveQuery(async () => {
    const cfg = await settingsRepo.get()
    const teams = await db.teams.orderBy('name').toArray()
    return teams.find((t) => t.id === cfg?.activeTeamId) ?? teams[0] ?? null
  }, [])
  const view = useSyncExternalStore(conversation?.subscribe ?? noSubscribe, conversation?.get ?? noView)

  if (!open || !conversation) return null
  const hidden = team && !sharedWithAssistant(team)

  return (
    <aside className="assist" aria-label="Assistant">
      <div className="assist-head">
        <b>Assistant</b>
        {team && <span className={`chip${hidden ? ' warn' : ''}`} title="The team it reads">{team.name}</span>}
        <span className="spacer" />
        <button className="btn ghost sm" disabled={view.items.length === 0} onClick={() => conversation.reset()}
          title="Start again: the assistant forgets this conversation">New</button>
        <button className="btn ghost sm" onClick={() => setOpen(false)} title="Hide (Ctrl+J)">Close</button>
      </div>

      {connection && !connection.connected ? (
        <div className="assist-empty">
          <p className="muted" style={{ marginTop: 0 }}>
            The assistant is Claude, from Anthropic. Connect an Anthropic API key in Settings and it can help with your
            day and your sprints.
          </p>
          <button className="btn primary" onClick={() => go('settings')}>Open Settings</button>
        </div>
      ) : (
        <>
          {hidden && (
            <div className="assist-notice info" style={{ margin: '10px 12px 0' }}>
              {team.name} is kept on this computer only, so the assistant cannot read it.{' '}
              <button className="md-key" onClick={() => go('settings')}>Allow it in Settings</button>
            </div>
          )}
          <Thread conversation={conversation} />
        </>
      )}
    </aside>
  )
}

const noSubscribe = () => () => {}
const EMPTY = { items: [], phase: 'idle' as const }
const noView = () => EMPTY
