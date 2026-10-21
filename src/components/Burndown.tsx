import { todayISO, type BurndownPoint } from '../repo'

/**
 * Work left against the ideal line, one point per working day.
 *
 * The actual line stops at `until`: today while a sprint runs, the day it
 * closed once it has. A sprint closed early would otherwise trail off in a flat
 * line across days that never happened.
 */
export function Burndown({ series, until }: { series: BurndownPoint[]; until?: string }) {
  if (series.length < 2) return <p className="small faint" style={{ margin: 0 }}>Not enough days to chart.</p>
  const w = 300, h = 96, pad = 4
  const max = Math.max(1, ...series.map((p) => Math.max(p.remaining, p.ideal)))
  const x = (i: number) => pad + (i * (w - pad * 2)) / (series.length - 1)
  const y = (v: number) => pad + ((max - v) * (h - pad * 2)) / max
  // todayISO, not toISOString: the rest of the app works in local dates, and
  // west of UTC the two disagree for part of every evening.
  const lastIdx = series.findIndex((p) => p.date >= (until ?? todayISO()))
  const upto = lastIdx === -1 ? series.length : lastIdx + 1
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-label="Burndown">
      <polyline fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="4 4"
        points={series.map((p, i) => `${x(i)},${y(p.ideal)}`).join(' ')} />
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5"
        points={series.slice(0, upto).map((p, i) => `${x(i)},${y(p.remaining)}`).join(' ')} />
    </svg>
  )
}
