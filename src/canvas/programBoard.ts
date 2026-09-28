/**
 * A PI program board, laid out the way it is on the wall: iterations across
 * the top, a milestones row, one row per team, and a key of sticky notes to
 * copy onto it. The grid is locked so dragging stickies around never moves it.
 *
 * Returns Excalidraw's skeleton format, like quickFlow; the caller converts it.
 */
import { addDays } from '../repo/sprints'

export interface Iteration { label: string; startDate: string; endDate: string }

const MAX_ITERATIONS = 8

const LABEL_W = 170
const COL_W = 240
const HEAD_H = 64
const MILESTONE_H = 100
const ROW_H = 140
const GAP = 6
const TOP = 60
const STICKY_W = 120
const STICKY_H = 64

// Excalidraw's "Normal" font; the hand-drawn default reads poorly at board scale.
const FONT = 6
const INK = '#1e1e1e'

export const STICKY_COLORS = {
  feature: '#bcd0fb',
  dependency: '#f8b4b4',
  milestone: '#fce68a',
} as const

function days(fromISO: string, toISO: string): number {
  return Math.round((new Date(`${toISO}T12:00:00`).getTime() - new Date(`${fromISO}T12:00:00`).getTime()) / 86_400_000)
}

const short = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/**
 * The PI cut into iterations of the team's sprint length. A PI rarely divides
 * exactly, so the count is rounded and the last one runs to the PI's end. With
 * three or more, the last is the Innovation and Planning iteration.
 */
export function piIterations(pi: { name: string; startDate: string; endDate: string }, lengthDays: number): Iteration[] {
  const len = Math.max(1, Math.round(lengthDays))
  const span = days(pi.startDate, pi.endDate) + 1
  const n = Math.min(MAX_ITERATIONS, Math.max(1, Math.round(span / len)))
  // "PI 3" numbers its iterations 3.1, 3.2 …; a PI named anything else just counts.
  const piNo = pi.name.match(/(\d+)\s*$/)?.[1]
  return Array.from({ length: n }, (_, i) => {
    const startDate = addDays(pi.startDate, i * len)
    const endDate = i === n - 1 ? pi.endDate : addDays(startDate, len - 1)
    const ip = n >= 3 && i === n - 1 ? ' (IP)' : ''
    return { label: `Iteration ${piNo ? `${piNo}.` : ''}${i + 1}${ip}`, startDate, endDate }
  })
}

function box(x: number, y: number, width: number, height: number, fill: string, text: string, opts: {
  color?: string; fontSize?: number; locked?: boolean; round?: boolean
} = {}): Record<string, unknown> {
  const locked = opts.locked ?? true
  return {
    type: 'rectangle',
    x, y, width, height,
    backgroundColor: fill,
    strokeColor: fill,
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 0,
    roundness: opts.round ? { type: 3 } : null,
    locked,
    ...(text
      ? { label: { text, fontSize: opts.fontSize ?? 16, fontFamily: FONT, strokeColor: opts.color ?? INK, locked } }
      : {}),
  }
}

function text(x: number, y: number, value: string, fontSize: number, opts: { color?: string; locked?: boolean } = {}) {
  return {
    type: 'text', x, y, text: value, fontSize, fontFamily: FONT,
    strokeColor: opts.color ?? INK, locked: opts.locked ?? true,
  }
}

export function programBoardSkeleton(input: { title: string; iterations: Iteration[]; teams: string[] }) {
  const { iterations, teams } = input
  const elements: Record<string, unknown>[] = []
  const colX = (i: number) => LABEL_W + GAP + i * (COL_W + GAP)
  const right = colX(iterations.length)

  elements.push(text(0, 0, input.title, 28))

  iterations.forEach((it, i) => {
    elements.push(box(colX(i), TOP, COL_W, HEAD_H, '#1e3a6e',
      `${it.label}\n${short(it.startDate)} – ${short(it.endDate)}`, { color: '#ffffff' }))
  })

  const rows = [
    { name: 'Milestones / Events', fill: '#f5c52b', height: MILESTONE_H },
    ...teams.map((name) => ({ name, fill: '#3fc9a0', height: ROW_H })),
  ]
  let y = TOP + HEAD_H + GAP
  for (const row of rows) {
    elements.push(box(0, y, LABEL_W, row.height, row.fill, row.name, { fontSize: 18 }))
    iterations.forEach((_, i) => elements.push(box(colX(i), y, COL_W, row.height, '#d5d7de', '')))
    y += row.height + GAP
  }

  // The key doubles as the pad of stickies: unlocked, so they can be copied.
  const kx = right + 40
  let ky = TOP
  elements.push(text(kx, ky, 'Key', 20))
  ky += 36
  const stickies: [string, string][] = [
    [STICKY_COLORS.feature, 'Feature / Enabler'],
    [STICKY_COLORS.dependency, 'Dependency'],
    [STICKY_COLORS.milestone, 'Milestone / Event'],
  ]
  for (const [fill, label] of stickies) {
    elements.push(box(kx, ky, STICKY_W, STICKY_H, fill, label, { fontSize: 14, locked: false, round: true }))
    ky += STICKY_H + 14
  }
  elements.push({
    type: 'arrow', x: kx, y: ky + 12, width: STICKY_W, height: 0,
    strokeColor: '#e03131', strokeWidth: 2, roughness: 0, locked: false,
  })
  elements.push(text(kx, ky + 22, 'Depends on', 14, { color: '#e03131' }))
  elements.push(text(kx, ky + 58, [
    'Ctrl+D copies a sticky —',
    'drag the copy into a cell.',
    'Draw a red arrow from a',
    'dependency to what needs it.',
    '',
    'The grid is locked. Right-click',
    '→ Unlock all to change it.',
  ].join('\n'), 14, { color: '#6b6b6b' }))

  return { elements }
}
