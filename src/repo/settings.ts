import { SCHEMA_VERSION, db } from '../db/schema'
import type { ID, Settings } from '../db/types'

export const DEFAULT_SETTINGS: Settings = {
  id: 1,
  sprintLengthDays: 14,
  sprintStartWeekday: 1,
  blockedMode: 'flag',
  sizeScale: 'points',
  activeTeamId: null,
  schemaVersion: SCHEMA_VERSION,
  lastBackupAt: null,
  setupComplete: false,
}

export const settings = {
  get: async (): Promise<Settings> => (await db.settings.get(1)) ?? DEFAULT_SETTINGS,

  /**
   * Safe to call twice at once. React's development mode runs startup effects
   * twice, so two callers used to race between the read and the write and the
   * loser threw ConstraintError into the console on every first run.
   */
  async ensure(): Promise<Settings> {
    const existing = await db.settings.get(1)
    if (existing) return existing
    try {
      await db.settings.add(DEFAULT_SETTINGS)
      return DEFAULT_SETTINGS
    } catch {
      return (await db.settings.get(1)) ?? DEFAULT_SETTINGS
    }
  },

  async update(patch: Partial<Omit<Settings, 'id'>>) {
    await settings.ensure()
    await db.settings.update(1, patch)
  },

  setActiveTeam: (teamId: ID | null) => settings.update({ activeTeamId: teamId }),
}
