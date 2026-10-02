import type { Snapshot } from '../repo/backup'

/**
 * The desktop build's view of the main process.
 *
 * `window.scrumlyDesktop` is injected by electron/preload.cjs and simply is not
 * there in a browser, which is what every `isDesktop()` check in the app keys
 * off. The same bundle runs in both places: nothing here is stubbed or
 * polyfilled, the desktop paths are just skipped.
 */

export interface DesktopInfo {
  /** The folder holding scrumly.json and history/. */
  dir: string
  file: string
  exists: boolean
  bytes: number
  modifiedAt: number | null
  /** False once the folder has been moved out of %APPDATA% from Settings. */
  isDefault: boolean
  /** Where teams kept on this computer only are written instead. Never moves. */
  localDir?: string
}

export interface DesktopWrite {
  dir: string
  file: string
  bytes: number
  at: number
}

export interface JiraConnection {
  connected: boolean
  site: string | null
  /** Jira's display name for whoever the token belongs to. */
  user: string | null
  /** True for email + API token (Jira Cloud), false for a personal access token. */
  cloud: boolean | null
  /** False when the OS cannot encrypt the token, in which case it is never stored. */
  encryption: boolean
}

export type JiraResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string }

/** The token goes in through connect() and is never handed back. */
export interface JiraBridge {
  status(): Promise<JiraConnection>
  connect(input: { site: string; email: string; token: string }): Promise<{ ok: true; site: string; user: string } | { ok: false; message: string }>
  disconnect(): Promise<void>
  /** A read-only GET of a Jira REST path, e.g. '/rest/agile/1.0/board?type=scrum'. */
  get<T = unknown>(apiPath: string): Promise<JiraResult<T>>
}

/**
 * The Sheets screen's way out for private sheets. Google will not sign anyone
 * in inside a desktop app, so those open in the user's own browser, where they
 * already are signed in (electron/sheets.cjs).
 */
export interface SheetsBridge {
  /**
   * Opens a Google Sheet in an app window of Chrome or Edge. Resolves with
   * where it went — an ordinary browser tab when neither could be started —
   * or null for an address that is not a sheet.
   */
  openWindow(url: string): Promise<'Chrome' | 'Edge' | 'browser' | null>
  /**
   * A sheet's frame landed on Google's sign-in page, which inside a frame
   * shows only an error — or, with `clicked`, the sheet's own Sign in button
   * was pressed. `url` is the sign-in address; its `continue` names the sheet.
   */
  onSignInNeeded(fn: (url: string, clicked: boolean) => void): () => void
}

export interface GoogleConnection {
  /** An OAuth client has been pasted in. */
  configured: boolean
  /** Google has granted access, and it has not run out or been revoked. */
  connected: boolean
  email: string | null
  /** False when the OS cannot encrypt the token, in which case it is never kept. */
  encryption: boolean
}

export interface SheetTab {
  /** Google's sheetId for the tab: the gid in a link. */
  id: string
  title: string
  frozenRows: number
}

export interface SheetData {
  title: string
  tabs: SheetTab[]
  /** The tab these values are from. */
  tab: string
  /** Rows of cells as Google displays them. Rows can be ragged, and end early. */
  values: string[][]
}

export type GoogleResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; expired?: boolean }

export type GoogleClientInput = { clientId: string; clientSecret: string } | { json: string }

/**
 * Private sheets inside Scrumly through Google's API (electron/google.cjs).
 * Consent happens in the user's own browser; the token never leaves the main
 * process.
 */
export interface GoogleBridge {
  status(): Promise<GoogleConnection>
  /**
   * Keeps `client` when given, then opens Google's consent page in the browser
   * and resolves once it answers — or is cancelled, or ten minutes pass.
   */
  connect(client?: GoogleClientInput): Promise<{ ok: true; email: string | null } | { ok: false; message: string }>
  cancel(): Promise<void>
  /** Forgets the access and revokes it with Google. The client is kept. */
  disconnect(): Promise<void>
  /** One tab's values: the one `gid` names, or the first. */
  read(spreadsheetId: string, gid: string | null): Promise<GoogleResult<SheetData>>
}

export interface DesktopApi {
  version: string
  info(): Promise<DesktopInfo>
  load(): Promise<unknown | null>
  save(snapshot: Snapshot): Promise<DesktopWrite>
  /** What is kept on this computer only. Absent in desktop builds from before it could be. */
  loadLocal?(): Promise<unknown | null>
  /** Null when nothing is kept here and never has been, so nothing was written. */
  saveLocal?(snapshot: Snapshot): Promise<DesktopWrite | null>
  chooseDir(): Promise<DesktopInfo | null>
  reveal(): Promise<void>
  /** Absent in desktop builds from before the Jira import. */
  jira?: JiraBridge
  /** Absent in desktop builds from before the Sheets screen. */
  sheets?: SheetsBridge
  /** Absent in desktop builds from before sheets could be read through Google's API. */
  google?: GoogleBridge
}

declare global {
  interface Window {
    scrumlyDesktop?: DesktopApi
    /** Set by the store so the main process can force a flush before quitting. */
    __scrumlyFlush?: () => Promise<void>
  }
}

export function desktopApi(): DesktopApi | null {
  return typeof window === 'undefined' ? null : window.scrumlyDesktop ?? null
}

export function isDesktop(): boolean {
  return desktopApi() !== null
}

export function jiraBridge(): JiraBridge | null {
  return desktopApi()?.jira ?? null
}

export function sheetsBridge(): SheetsBridge | null {
  return desktopApi()?.sheets ?? null
}

export function googleBridge(): GoogleBridge | null {
  return desktopApi()?.google ?? null
}

/** Human-sized, for the Settings panel. Bytes are never the interesting part. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
