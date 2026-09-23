/**
 * Turning a date into text for the screen. Always dd/mm/yyyy.
 *
 * Every screen used to format its own, and each picked something different —
 * "5 Mar" in the task drawer, "5 March" at setup, the browser's locale default
 * in Settings, and a raw "2026-03-05" wherever an ISO string reached the page
 * unformatted. Reading one number as a date in four shapes is a good way to
 * misread it, so there is one function now and the screens call it.
 *
 * Nothing here touches how dates are *stored*. Sprint dates and due dates stay
 * ISO 'YYYY-MM-DD' in the database, because that sorts and compares correctly
 * as a plain string and the repo layer relies on it. This is display only.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isNaN(value) ? null : new Date(value)

  // A bare 'YYYY-MM-DD' is parsed as UTC midnight, which is the day before
  // anywhere west of Greenwich. Reading it at midday local keeps the date the
  // one that was typed, whatever the timezone.
  const d = new Date(ISO_DAY.test(value) ? `${value}T12:00:00` : value)
  return Number.isNaN(d.getTime()) ? null : d
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 21/09/2026. The one date format in the app. */
export function formatDate(value: string | number | Date | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  const d = toDate(value)
  if (!d) return fallback
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

/**
 * Monday, 21/09/2026 — for the one place a weekday earns its width. The
 * weekday name is still the reader's language; only the numbers are fixed.
 */
export function formatDateWithWeekday(value: string | number | Date, fallback = '—'): string {
  const d = toDate(value)
  if (!d) return fallback
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })}, ${formatDate(d)}`
}

/** What the database stores and compares: 'YYYY-MM-DD', local, never UTC. */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Reads what somebody typed into a date field, day first. Returns ISO, or null
 * if it is not a real date.
 *
 * Deliberately forgiving about separators and padding — `1/9/26`, `01-09-2026`
 * and `1.9.2026` all mean the same thing to the person typing them — and
 * deliberately strict about the result. 31/02/2026 is rejected rather than
 * rolled forward into March, because a silently moved date is worse than a
 * rejected one.
 */
export function parseDateInput(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\s*[/.\-\s]\s*(\d{1,2})\s*[/.\-\s]\s*(\d{2}|\d{4})$/)
  if (!m) return null

  const day = Number(m[1])
  const month = Number(m[2])
  // A two-digit year is this century. Scrumly plans sprints, not history.
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const d = new Date(year, month - 1, day, 12)
  // Date rolls 31 February over into March instead of refusing. Reading the
  // parts back is the only way to know the date survived intact.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return toISODate(d)
}
