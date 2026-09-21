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
