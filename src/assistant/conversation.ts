import type Anthropic from '@anthropic-ai/sdk'
import type { ID } from '../db/types'
import type { AssistantBridge, AssistantResult } from '../desktop/bridge'
import { newId } from '../repo/ids'
import { teamReport } from './context'
import { SYSTEM } from './prompt'
import { sight } from './sight'
import { runTool, TOOLS, type Proposal } from './tools'

type Block = Anthropic.Beta.BetaContentBlock
type BlockParam = Anthropic.Beta.BetaContentBlockParam
type ToolUse = Anthropic.Beta.BetaToolUseBlock
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam

export type ProposalState = 'pending' | 'applying' | 'applied' | 'skipped' | 'failed'

/** What the panel draws, in order. The conversation sent to Claude is kept separately. */
export type Item =
  | { id: string; kind: 'user'; text: string }
  /** `live` while its text is still arriving. */
  | { id: string; kind: 'assistant'; text: string; live: boolean }
  /** A line saying what was looked at. */
  | { id: string; kind: 'activity'; text: string }
  | { id: string; kind: 'proposal'; title: string; lines: string[]; body?: string; state: ProposalState; outcome?: string }
  | { id: string; kind: 'notice'; text: string; tone: 'error' | 'info' }

/** Idle; waiting on Claude; waiting on the user to apply or skip. */
export type Phase = 'idle' | 'thinking' | 'waiting'

export interface View { items: Item[]; phase: Phase }

export type Decision = 'apply' | 'skip'

/**
 * Content to send back as the assistant's turn. After a server-side fallback
 * part-way through a reply, what came before the switch is echoed as text
 * only: the declined model's thinking and tool calls mean nothing to the one
 * that took over. The fallback marker itself is only an audit trail.
 */
export function echoable(content: Block[]): BlockParam[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  return content.filter((b, i) => b.type !== 'fallback' && (i > boundary || b.type === 'text')) as BlockParam[]
}

/**
 * One conversation with the assistant.
 *
 * Plain TypeScript rather than React state, so the loop can be driven by a
 * fake bridge in the smoke tests, and so closing the panel does not end it.
 *
 * The history sent to Claude only ever grows. Earlier turns are never edited
 * or dropped once sent: the model checks its own earlier reasoning against
 * them, and an edited history throws that away.
 */
export class Conversation {
  private view: View = { items: [], phase: 'idle' }
  private history: Anthropic.Beta.BetaMessageParam[] = []
  private listeners = new Set<() => void>()
  /** Bumped by reset(), so a request still in flight from before cannot touch the new conversation. */
  private generation = 0
  private requestId: string | null = null
  private stopped = false
  /**
   * The team Claude was last told about, and whether it could see it — so a
   * switch of team, or a team let through in Settings since, is told rather
   * than missed.
   */
  private shownTeam: string | null = null
  private pending = new Map<string, { proposal: Proposal; result: ToolResult; settle: () => void }>()

  constructor(
    private readonly bridge: AssistantBridge,
    /** The team open in Scrumly right now. */
    private readonly activeTeam: () => Promise<ID | null>,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** The same object until something changes, as useSyncExternalStore needs. */
  get = (): View => this.view

  private set(next: Partial<View>) {
    this.view = { ...this.view, ...next }
    for (const fn of this.listeners) fn()
  }

  private add<T extends Item>(item: T): T {
    this.set({ items: [...this.view.items, item] })
    return item
  }

  private change(id: string, fn: (item: Item) => Item) {
    this.set({ items: this.view.items.map((i) => (i.id === id ? fn(i) : i)) })
  }

  private drop(id: string) {
    this.set({ items: this.view.items.filter((i) => i.id !== id) })
  }

  private notice(text: string, tone: 'error' | 'info') {
    this.add({ id: newId(), kind: 'notice', text, tone })
  }

  async send(input: string): Promise<void> {
    const words = input.trim()
    if (!words || this.view.phase !== 'idle') return
    const gen = this.generation
    this.stopped = false
    this.add({ id: newId(), kind: 'user', text: words })
    this.set({ phase: 'thinking' })
    try {
      const content = await this.opening(words)
      if (gen !== this.generation) return
      this.history.push({ role: 'user', content })
      await this.run(gen)
    } catch (err) {
      if (gen === this.generation) this.notice(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      if (gen === this.generation) this.set({ phase: 'idle' })
    }
  }

  /**
   * The user's words, after the open team's board when Claude has not seen it
   * yet — at the start, or because the user has switched team since.
   */
  private async opening(words: string): Promise<BlockParam[]> {
    const teamId = await this.activeTeam()
    const blocks: BlockParam[] = []
    if (teamId) {
      const s = await sight()
      const team = s.teams.find((t) => t.id === teamId)
      const kept = s.closed.find((t) => t.id === teamId)
      const shown = `${teamId}:${team ? 'seen' : 'hidden'}`
      if (shown !== this.shownTeam) {
        const sameTeam = this.shownTeam?.startsWith(`${teamId}:`)
        const lead = this.shownTeam === null ? ''
          : !sameTeam ? 'The user has switched Scrumly to another team. '
            : team ? 'The user has just let you read the open team. '
              : 'The user has stopped sharing the open team with you. '
        if (team) {
          blocks.push({ type: 'text', text: `${lead}<board>\n${await teamReport(team, s)}\n</board>` })
        } else if (kept) {
          blocks.push({
            type: 'text',
            text: `${lead}The team open in Scrumly, ${kept.name}, is kept on this computer only and the user has not shared it `
              + `with you, so you cannot see it. Teams you can read: ${s.teams.map((t) => t.name).join(', ') || 'none'}.`,
          })
        }
        this.shownTeam = shown
      }
    }
    blocks.push({ type: 'text', text: words })
    return blocks
  }

  private async run(gen: number) {
    let retries = 0
    while (!this.stopped && gen === this.generation) {
      this.set({ phase: 'thinking' })
      const live = this.add({ id: newId(), kind: 'assistant', text: '', live: true })
      const requestId = newId()
      this.requestId = requestId
      let streamed = ''
      const off = this.bridge.onText((id, delta) => {
        if (id !== requestId || gen !== this.generation) return
        streamed += delta
        this.change(live.id, (i) => ({ ...i, text: streamed }) as Item)
      })
      let result: AssistantResult
      try {
        result = await this.bridge.send(requestId, { system: SYSTEM, tools: TOOLS, messages: this.history })
      } finally {
        off()
        this.requestId = null
      }
      if (gen !== this.generation) return

      if (!result.ok) {
        if (result.retry && retries++ < 2 && !this.stopped) { this.drop(live.id); continue }
        this.settle(live.id, streamed)
        if (!result.aborted) this.notice(result.error, 'error')
        return
      }
      retries = 0
      const reply = result.reply
      const content = echoable(reply.content)
      this.settle(live.id, content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n') || streamed)

      if (reply.stop_reason === 'refusal') {
        this.notice('Claude declined to answer that. Asking another way usually works.', 'info')
        return
      }
      const uses = content.filter((b): b is ToolUse => b.type === 'tool_use')
      // A tool call cut off by the length limit can still parse as something
      // plausible. Never act on one; the turn is left out of the history.
      if (reply.stop_reason === 'max_tokens' && uses.length) {
        this.notice('The reply ran out of room part-way through. Ask again, perhaps for less at once.', 'error')
        return
      }
      this.history.push({ role: 'assistant', content })
      if (reply.stop_reason === 'pause_turn') continue
      if (!uses.length) return

      const results = await this.answer(uses)
      if (gen !== this.generation) return
      // Every call answered in one message, even after Stop, so the history
      // stays one Claude will accept.
      this.history.push({ role: 'user', content: results })
    }
  }

  private settle(id: string, text: string) {
    if (!text.trim()) this.drop(id)
    else this.change(id, (i) => ({ ...i, text, live: false }) as Item)
  }

  /** Reads answer at once; proposals wait for Apply or Skip. Resolves when every call has a result. */
  private async answer(uses: ToolUse[]): Promise<ToolResult[]> {
    const activeTeamId = (await this.activeTeam()) ?? ''
    const results: ToolResult[] = []
    const waits: Promise<void>[] = []
    for (const use of uses) {
      const outcome = await runTool(use.name, use.input, { activeTeamId })
      if (outcome.kind === 'result') {
        if (outcome.note) this.add({ id: newId(), kind: 'activity', text: outcome.note })
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.text, ...(outcome.error ? { is_error: true } : {}) })
        continue
      }
      const { proposal } = outcome
      const id = newId()
      const result: ToolResult = { type: 'tool_result', tool_use_id: use.id, content: '' }
      results.push(result)
      this.add({ id, kind: 'proposal', title: proposal.title, lines: proposal.lines, body: proposal.body, state: 'pending' })
      waits.push(new Promise<void>((settle) => { this.pending.set(id, { proposal, result, settle }) }))
    }
    if (waits.length) {
      if (this.stopped) this.skipAll()
      else this.set({ phase: 'waiting' })
      await Promise.all(waits)
    }
    return results
  }

  /** Apply or skip one proposal. Applying goes through the repo layer, like any screen. */
  async decide(id: string, choice: Decision): Promise<void> {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (choice === 'skip') {
      p.result.content = 'The user chose not to apply this.'
      this.change(id, (i) => ({ ...i, state: 'skipped' }) as Item)
    } else {
      this.change(id, (i) => ({ ...i, state: 'applying' }) as Item)
      try {
        const said = await p.proposal.apply()
        p.result.content = said
        const outcome = said.replace(/^Applied: /, '')
        this.change(id, (i) => ({ ...i, state: 'applied', outcome: outcome[0].toUpperCase() + outcome.slice(1) }) as Item)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        p.result.content = `Applying it failed: ${why}`
        p.result.is_error = true
        this.change(id, (i) => ({ ...i, state: 'failed', outcome: why }) as Item)
      }
    }
    p.settle()
  }

  /** One after another, in the order proposed, so a later change lands on top of an earlier one. */
  async decideAll(choice: Decision): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.decide(id, choice)
  }

  /** Skipping needs no waiting, so every one is settled before this returns. */
  private skipAll() {
    for (const id of [...this.pending.keys()]) void this.decide(id, 'skip')
  }

  /** Stops whatever is running. Proposals still waiting are skipped. */
  stop() {
    this.stopped = true
    if (this.requestId) void this.bridge.cancel(this.requestId)
    this.skipAll()
  }

  /** A new conversation: Claude sees the board afresh and remembers nothing of this one. */
  reset() {
    this.stop()
    this.generation++
    this.history = []
    this.shownTeam = null
    this.pending.clear()
    this.set({ items: [], phase: 'idle' })
  }
}
