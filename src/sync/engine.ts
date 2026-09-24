import { createClient, type RealtimeChannel, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { db } from '../db/schema'
import { SUPABASE_ANON_KEY, SUPABASE_URL, syncConfigured } from './config'
import { applyIncoming, readOutgoing, type RemoteRow } from './rows'
import { tracker } from './tracker'

/**
 * Keeps this device's database and the Supabase copy in step.
 *
 * IndexedDB stays the live store: every screen still reads and writes it and
 * works with no connection. This only moves rows. A change here is sent a
 * moment later; a change elsewhere arrives over realtime, or on the next pull
 * when the app comes back to the foreground.
 *
 * Conflicts are per row and the last save wins. A row with an unsent change on
 * this device is never overwritten by an incoming one — it is about to be sent,
 * and then it is the last save.
 */

const TABLE = 'scrumly_rows'
const PUSH_DEBOUNCE = 1200
const PAGE = 1000
/** Rows per upsert, and a rough cap on the body, since a canvas can be large. */
const BATCH_ROWS = 500
const BATCH_BYTES = 1_500_000

export type SyncPhase = 'off' | 'signedOut' | 'starting' | 'choose' | 'syncing' | 'synced' | 'offline' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  email: string | null
  pending: number
  lastSyncedAt: number | null
  error: string | null
  /** When this device and the cloud both have data and it is not yet known which wins. */
  choice: { cloudRows: number } | null
}

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key)
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* storage unavailable */ }
  return null
}

const deviceId: string = (() => {
  const existing = store('scrumly-sync-device')
  if (existing) return existing
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  store('scrumly-sync-device', id)
  return id
})()

const cursorKey = (uid: string) => `scrumly-sync-cursor:${uid}`

async function databaseHasContent(): Promise<boolean> {
  return (await db.teams.count()) > 0 || (await db.tasks.count()) > 0
}

class SyncEngine {
  client: SupabaseClient | null = null
  private session: Session | null = null
  private channel: RealtimeChannel | null = null
  private timer: number | null = null
  private pushing = false
  private pushAgain = false
  private pulling: Promise<void> | null = null
  private pullAgain = false
  private listeners = new Set<(s: SyncStatus) => void>()
  status: SyncStatus = {
    phase: 'off', email: null, pending: tracker.count(), lastSyncedAt: null, error: null, choice: null,
  }

  constructor() {
    if (!syncConfigured()) return
    this.client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'scrumly-sync-auth' },
    })
    this.status.phase = 'starting'
    tracker.onChange(() => {
      this.set({ pending: tracker.count() })
      this.schedulePush()
    })
    this.client.auth.onAuthStateChange((event, session) => {
      const before = this.session?.user.id
      this.session = session
      if (!session) { this.stop(); this.set({ phase: 'signedOut', email: null, choice: null }); return }
      // Token refreshes arrive here too; only a new user needs a fresh start.
      if (before !== session.user.id || event === 'INITIAL_SESSION') {
        // Out of the callback: supabase-js holds a lock while it runs.
        window.setTimeout(() => { void this.start() }, 0)
      }
    })
    window.addEventListener('online', () => { void this.kick() })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.kick()
      else if (this.timer !== null) void this.push()
    })
    window.setInterval(() => { if (document.visibilityState === 'visible') void this.kick() }, 60_000)
  }

  subscribe(fn: (s: SyncStatus) => void) {
    this.listeners.add(fn)
    fn(this.status)
    return () => { this.listeners.delete(fn) }
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch }
    for (const fn of this.listeners) fn(this.status)
  }

  private get uid() { return this.session?.user.id ?? null }

  async signIn(email: string, password: string): Promise<string | null> {
    if (!this.client) return 'Sync is not set up in this build'
    const { error } = await this.client.auth.signInWithPassword({ email: email.trim(), password })
    return error ? error.message : null
  }

  async signOut() {
    if (!this.client) return
    tracker.setTracking(false)
    tracker.clear()
    await this.client.auth.signOut()
  }

  /**
   * First sign-in on a device decides where the data comes from. An empty
   * cloud gets this device's data; an empty device gets the cloud's; if both
   * have some, the person decides, because either answer loses something.
   */
  private async start() {
    const uid = this.uid
    if (!uid || !this.client) return
    this.set({ phase: 'starting', email: this.session?.user.email ?? null, error: null })
    try {
      if (store(cursorKey(uid)) !== null) {
        tracker.setTracking(true)
        this.listen()
        await this.kick()
        return
      }
      const { count, error } = await this.client.from(TABLE).select('id', { count: 'exact', head: true })
      if (error) throw error
      const cloudRows = count ?? 0
      if (cloudRows === 0) {
        await this.useThisDevice()
      } else if (!(await databaseHasContent())) {
        await this.useCloud()
      } else {
        this.set({ phase: 'choose', choice: { cloudRows } })
      }
    } catch (err) {
      this.fail(err)
    }
  }

  /** Replace this device's data with the cloud's. */
  async useCloud() {
    const uid = this.uid
    if (!uid) return
    this.set({ phase: 'syncing', choice: null })
    try {
      tracker.setTracking(false)
      tracker.clear()
      const rows = await this.fetchSince(0)
      await applyIncoming(rows, true)
      this.finishStart(uid, rows)
    } catch (err) {
      this.fail(err)
    }
  }

  /** Send everything on this device up, merging it with whatever is already there. */
  async useThisDevice() {
    const uid = this.uid
    if (!uid) return
    this.set({ phase: 'syncing', choice: null })
    try {
      tracker.setTracking(true)
      await tracker.markAll()
      await this.push()
      if (tracker.count() > 0) throw new Error('Some rows could not be uploaded')
      const rows = await this.fetchSince(0)
      await applyIncoming(rows, false)
      this.finishStart(uid, rows)
    } catch (err) {
      this.fail(err)
    }
  }

  private finishStart(uid: string, rows: RemoteRow[]) {
    const top = rows.reduce((m, r) => Math.max(m, r.seq), 0)
    store(cursorKey(uid), String(top))
    tracker.setTracking(true)
    this.listen()
    this.set({ phase: 'synced', lastSyncedAt: Date.now(), pending: tracker.count(), error: null })
    // Anything the cloud should not have had was queued for deletion on the way in.
    if (tracker.count()) this.schedulePush()
  }

  /** Pull everything again from the start, e.g. after something looked out of step. */
  async resync() {
    const uid = this.uid
    if (!uid) return
    store(cursorKey(uid), '0')
    await this.kick()
  }

  private stop() {
    if (this.channel && this.client) void this.client.removeChannel(this.channel)
    this.channel = null
  }

  private listen() {
    if (!this.client || this.channel || !this.uid) return
    this.channel = this.client
      .channel(`scrumly-${this.uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: `user_id=eq.${this.uid}` },
        () => { void this.pull() })
      .subscribe()
  }

  private fail(err: unknown) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? 'Sync failed'
    this.set({ phase: offline ? 'offline' : 'error', error: offline ? null : message })
  }

  /** Push what is pending, then pull what is new. */
  async kick() {
    if (!this.uid || !tracker.isTracking() || this.status.phase === 'choose') return
    await this.push()
    await this.pull()
  }

  private schedulePush() {
    if (!this.uid || !tracker.isTracking()) return
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => { this.timer = null; void this.push() }, PUSH_DEBOUNCE)
  }

  async push() {
    const uid = this.uid
    if (!uid || !this.client) return
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null }
    if (this.pushing) { this.pushAgain = true; return }
    this.pushing = true
    try {
      const entries = tracker.pending()
      if (!entries.length) return
      this.set({ phase: 'syncing' })

      // Read each row as it is now. Gone, or kept on this computer, means deleted.
      const out: { row: Omit<RemoteRow, 'seq'>; entry: [string, number] }[] = (await readOutgoing(entries))
        .map(({ entry, tbl, id, data }) => ({ entry, row: { user_id: uid, tbl, id, data, deleted: !data, device: deviceId } }))

      let batch: typeof out = []
      let bytes = 0
      const send = async () => {
        if (!batch.length) return
        const { error } = await this.client!.from(TABLE).upsert(batch.map((b) => b.row), { onConflict: 'user_id,tbl,id' })
        if (error) throw error
        tracker.sent(batch.map((b) => b.entry))
        batch = []
        bytes = 0
      }
      for (const item of out) {
        const size = item.row.data ? JSON.stringify(item.row.data).length : 50
        if (batch.length && (batch.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) await send()
        batch.push(item)
        bytes += size
      }
      await send()
      this.set({ phase: 'synced', lastSyncedAt: Date.now(), pending: tracker.count(), error: null })
    } catch (err) {
      this.fail(err)
    } finally {
      this.pushing = false
      if (this.pushAgain) { this.pushAgain = false; void this.push() }
    }
  }

  async pull() {
    if (this.pulling) { this.pullAgain = true; return this.pulling }
    this.pulling = (async () => {
      const uid = this.uid
      if (!uid || !this.client || !tracker.isTracking()) return
      try {
        const cursor = Number(store(cursorKey(uid)) ?? '0')
        // A little overlap: a write that took a number just before the last one
        // seen can commit just after it. Rows already applied are skipped.
        const rows = await this.fetchSince(Math.max(0, cursor - 100))
        await applyIncoming(rows, false)
        const top = rows.reduce((m, r) => Math.max(m, r.seq), cursor)
        store(cursorKey(uid), String(top))
        this.set({
          phase: tracker.count() ? this.status.phase : 'synced',
          lastSyncedAt: Date.now(), error: null, pending: tracker.count(),
        })
      } catch (err) {
        this.fail(err)
      }
    })()
    try {
      await this.pulling
    } finally {
      this.pulling = null
      if (this.pullAgain) { this.pullAgain = false; void this.pull() }
    }
  }

  private async fetchSince(after: number): Promise<RemoteRow[]> {
    const all: RemoteRow[] = []
    let from = after
    for (;;) {
      const { data, error } = await this.client!.from(TABLE)
        .select('tbl,id,data,deleted,device,seq')
        .gt('seq', from).order('seq', { ascending: true }).limit(PAGE)
      if (error) throw error
      const page = (data ?? []) as RemoteRow[]
      all.push(...page)
      if (page.length < PAGE) return all
      from = page[page.length - 1].seq
    }
  }
}

export const sync = new SyncEngine()
