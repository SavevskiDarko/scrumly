/**
 * Turns "Frontend → API → Backend → Database" into a laid-out, connected
 * diagram. Both examples in the original brief were arrow chains, so this may
 * end up being how most diagrams get made.
 *
 * Returns Excalidraw's skeleton format; convertToExcalidrawElements fills in
 * the rest, including the arrow bindings that make connectors follow shapes.
 */

const SEPARATOR = /\s*(?:→|-+>|=+>|»|\|)\s*/

const NODE_W = 150
const NODE_H = 64
const GAP = 74
const ROW_GAP = 48

export function parseFlowLine(line: string): string[] {
  return line.split(SEPARATOR).map((s) => s.trim()).filter(Boolean)
}

export function parseFlow(input: string): string[][] {
  return input
    .split('\n')
    .map(parseFlowLine)
    .filter((row) => row.length > 0)
}

/** True when the text actually describes a chain rather than a single word. */
export function looksLikeFlow(input: string): boolean {
  return parseFlow(input).some((row) => row.length > 1)
}

export interface FlowSkeleton {
  elements: Record<string, unknown>[]
  width: number
  height: number
}

export function flowSkeleton(rows: string[][], origin = { x: 0, y: 0 }, idPrefix = 'qf'): FlowSkeleton {
  const elements: Record<string, unknown>[] = []
  let widest = 0

  rows.forEach((labels, r) => {
    const y = origin.y + r * (NODE_H + ROW_GAP)
    labels.forEach((label, i) => {
      elements.push({
        type: 'rectangle',
        id: `${idPrefix}-${r}-${i}`,
        x: origin.x + i * (NODE_W + GAP),
        y,
        width: NODE_W,
        height: NODE_H,
        strokeWidth: 2,
        roundness: { type: 3 },
        label: { text: label, fontSize: 16 },
      })
    })
    for (let i = 0; i < labels.length - 1; i++) {
      elements.push({
        type: 'arrow',
        id: `${idPrefix}-${r}-a${i}`,
        x: origin.x + i * (NODE_W + GAP) + NODE_W + 8,
        y: y + NODE_H / 2,
        width: GAP - 16,
        height: 0,
        strokeWidth: 2,
        start: { id: `${idPrefix}-${r}-${i}` },
        end: { id: `${idPrefix}-${r}-${i + 1}` },
      })
    }
    widest = Math.max(widest, labels.length * NODE_W + (labels.length - 1) * GAP)
  })

  return {
    elements,
    width: widest,
    height: rows.length * NODE_H + Math.max(0, rows.length - 1) * ROW_GAP,
  }
}
