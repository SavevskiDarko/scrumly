import type { Sheet, SheetView } from '../db/types'
import type { SheetRef } from '../repo/sheets'

/*
 * The in-app table for a Google Sheet: what is drawn from the values Google's
 * API hands back. Nothing here touches the network or the database, so it is
 * tested without either.
 */

/** Google's own column letters: A … Z, AA … AZ, BA … */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** Right-aligned, as a sheet does: 12, -3.5, 1,234.00, 45%, $9.99, (120), 1.2E+3. */
export function looksNumeric(value: string): boolean {
  return /^[-+(]?[$€£¥]?\s?\d[\d.,\s]*(?:[eE][-+]?\d+)?\s?[%€]?\)?$/.test(value.trim())
}

/** A cell that is nothing but a web address becomes a link. */
export function linkIn(value: string): string | null {
  const v = value.trim()
  return /^https?:\/\/\S+$/i.test(v) ? v : null
}

export interface TableRow {
  /** 0-based row number in the sheet, so a filtered table still says which row. */
  index: number
  cells: string[]
  /** Frozen in Google, and kept in sight here: never filtered out, and pinned while scrolling. */
  frozen: boolean
}

export interface Table {
  rows: TableRow[]
  /** The widest row, so every row gets the same columns. */
  width: number
  /** Rows matching before the cap. */
  matched: number
  /** Rows left out by the cap. */
  hidden: number
}

/** More than this and the screen stops being quick; the rest is a click away in Google. */
export const ROW_CAP = 2000

/**
 * The rows to draw. A filter keeps the frozen rows — or the first row when
 * none is frozen, which is nearly always the header — and any row with a cell
 * containing the text.
 */
export function buildTable(values: string[][], frozenRows: number, filter = '', cap = ROW_CAP): Table {
  const needle = filter.trim().toLowerCase()
  const keep = Math.max(frozenRows, 1)
  const width = values.reduce((w, row) => Math.max(w, row.length), 0)
  const all = values.map((cells, index): TableRow => ({ index, cells, frozen: index < frozenRows }))
  const matching = needle
    ? all.filter((r) => r.index < keep || r.cells.some((c) => String(c).toLowerCase().includes(needle)))
    : all
  return { rows: matching.slice(0, cap), width, matched: matching.length, hidden: Math.max(0, matching.length - cap) }
}

/**
 * Editor or table for one sheet. The table only exists in the desktop app and
 * only for a sheet the API can read — a published one has no id it accepts,
 * and opens anywhere anyway. A choice made by hand stands; until one is, the
 * table once Google is connected, because that is why it was connected.
 */
export function viewFor(sheet: Pick<Sheet, 'view'>, ref: SheetRef | null, can: { api: boolean; connected: boolean }): SheetView {
  if (!can.api || !ref || ref.published) return 'editor'
  return sheet.view ?? (can.connected ? 'table' : 'editor')
}
