import { db } from '../db/schema'
import type { ID, Sheet } from '../db/types'
import { newId } from './ids'

/*
 * Google Sheets kept to hand. Scrumly stores the link and nothing else: the
 * Sheets screen opens the real sheet from Google in a frame, so it is always
 * current, editable by whoever Google lets edit it, and none of its contents
 * pass through this database, a backup, or sync.
 */

const BASE = 'https://docs.google.com/spreadsheets'

/** What a link says about the sheet it points at. */
export interface SheetRef {
  /** Google's id for the file. For one published to the web, the 2PACX-… id of the published copy. */
  fileId: string
  /** File → Share → Publish to web. Read-only, and opens for anyone, signed in or not. */
  published: boolean
  /** The tab the link was copied from, when it named one. */
  gid: string | null
  /** The 1 in /u/1/: which of several signed-in Google accounts opens it. */
  account: string | null
}

export const NOT_A_SHEET = 'That is not a Google Sheets link. Copy it from the sheet\'s address bar, or from Share → Copy link.'

/**
 * Reads a pasted Google Sheets link, or null when it is not one. Forgiving
 * about where the link came from — the address bar, Share → Copy link, Publish
 * to web, a link to one tab — and strict about the host, because whatever this
 * accepts is loaded into a frame inside the app.
 */
export function parseSheetUrl(input: string): SheetRef | null {
  const text = input.trim()
  // A bare id, as some people copy out of the address bar.
  if (/^[A-Za-z0-9_-]{25,}$/.test(text)) return { fileId: text, published: false, gid: null, account: null }

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.hostname !== 'docs.google.com') return null
  const m = /^\/spreadsheets\/(?:u\/(\d+)\/)?d\/(e\/)?([A-Za-z0-9_-]{20,})(?:\/|$)/.exec(url.pathname)
  if (!m) return null
  // New links carry the tab twice, ?gid= and #gid=; older ones only after the #.
  const gid = url.searchParams.get('gid') ?? /(?:^#|&)gid=(\d+)/.exec(url.hash)?.[1] ?? null
  return {
    fileId: m[3],
    published: Boolean(m[2]),
    gid: gid && /^\d+$/.test(gid) ? gid : null,
    account: m[1] ?? null,
  }
}

/** Where the frame points: the full editor, or the published page sized for embedding. */
export function embedUrl(ref: SheetRef): string {
  if (ref.published) {
    const q = new URLSearchParams({ widget: 'true', headers: 'false' })
    if (ref.gid) q.set('gid', ref.gid)
    return `${BASE}/d/e/${ref.fileId}/pubhtml?${q}`
  }
  const account = ref.account ? `u/${ref.account}/` : ''
  const tab = ref.gid ? `?gid=${ref.gid}#gid=${ref.gid}` : ''
  return `${BASE}/${account}d/${ref.fileId}/edit${tab}`
}

/** The same sheet in a real browser tab. */
export function browserUrl(ref: SheetRef): string {
  if (ref.published) return `${BASE}/d/e/${ref.fileId}/pubhtml${ref.gid ? `?gid=${ref.gid}` : ''}`
  const account = ref.account ? `u/${ref.account}/` : ''
  return `${BASE}/${account}d/${ref.fileId}/edit${ref.gid ? `#gid=${ref.gid}` : ''}`
}

/**
 * Which sheet a frame was asking for when it landed on Google's sign-in page,
 * read from where the sign-in would continue to. Null for anything else —
 * notably Docs' own inner frames, which visit the sign-in page on every sheet,
 * public ones included, and must not cover a sheet that is working.
 */
export function signInTarget(signInUrl: string): string | null {
  let target: string | null = null
  try { target = new URL(signInUrl).searchParams.get('continue') } catch { return null }
  return target ? parseSheetUrl(target)?.fileId ?? null : null
}

/** A bare id becomes a link, so the stored url is always one that opens. */
function stored(input: string, ref: SheetRef): string {
  const text = input.trim()
  if (!text.includes('/')) return browserUrl(ref)
  return /^https?:\/\//i.test(text) ? text : `https://${text}`
}

const sameSheet = (a: SheetRef, b: SheetRef) => a.fileId === b.fileId && a.gid === b.gid

export type SheetResult = { ok: true; sheet: Sheet } | { ok: false; reason: string }

export const sheets = {
  /** The open team's, and those kept for every team, in the order they were added. */
  async listForTeam(teamId: ID): Promise<Sheet[]> {
    const rows = await db.sheets.orderBy('createdAt').toArray()
    return rows.filter((s) => s.teamId === null || s.teamId === teamId)
  },

  get: (id: ID) => db.sheets.get(id),

  async add(input: { url: string; title?: string; teamId: ID | null }): Promise<SheetResult> {
    const ref = parseSheetUrl(input.url)
    if (!ref) return { ok: false, reason: NOT_A_SHEET }
    // The same tab twice for one team is a second click on Add, not a second sheet.
    for (const s of await db.sheets.toArray()) {
      const other = parseSheetUrl(s.url)
      const visible = s.teamId === null || s.teamId === input.teamId || input.teamId === null
      if (other && visible && sameSheet(other, ref)) return { ok: false, reason: `That sheet is already here, as ${s.title}.` }
    }
    const row: Sheet = {
      id: newId(),
      title: input.title?.trim() || 'Untitled sheet',
      url: stored(input.url, ref),
      teamId: input.teamId,
      createdAt: Date.now(),
    }
    await db.sheets.add(row)
    return { ok: true, sheet: row }
  },

  async update(id: ID, patch: { title?: string; url?: string; teamId?: ID | null }): Promise<{ ok: boolean; reason?: string }> {
    const changes: Partial<Sheet> = {}
    if (patch.url !== undefined) {
      const ref = parseSheetUrl(patch.url)
      if (!ref) return { ok: false, reason: NOT_A_SHEET }
      changes.url = stored(patch.url, ref)
    }
    if (patch.title !== undefined) changes.title = patch.title.trim() || 'Untitled sheet'
    if (patch.teamId !== undefined) changes.teamId = patch.teamId
    await db.sheets.update(id, changes)
    return { ok: true }
  },

  /** Only the link: the sheet itself stays in Google, exactly as it was. */
  remove: (id: ID) => db.sheets.delete(id),
}
