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

export interface DesktopApi {
  version: string
  info(): Promise<DesktopInfo>
  load(): Promise<unknown | null>
  save(snapshot: Snapshot): Promise<DesktopWrite>
  chooseDir(): Promise<DesktopInfo | null>
  reveal(): Promise<void>
  /** Absent in desktop builds from before the Jira import. */
  jira?: JiraBridge
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

/** Human-sized, for the Settings panel. Bytes are never the interesting part. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
