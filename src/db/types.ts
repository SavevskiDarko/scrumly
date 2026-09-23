export type ID = string
export type Priority = 'low' | 'normal' | 'high' | 'urgent'

export interface Settings {
  id: number
  sprintLengthDays: number
  sprintStartWeekday: number
  blockedMode: 'flag' | 'column'
  sizeScale: 'points' | 'tshirt' | 'none'
  activeTeamId: ID | null
  schemaVersion: number
  lastBackupAt: number | null
  setupComplete: boolean
}

export interface Team {
  id: ID
  name: string
  keyPrefix: string
  nextTaskNumber: number
  createdAt: number
  archivedAt: number | null
  /**
   * The order stand-ups run in, when it has been arranged by hand. Absent on
   * teams created before the Stand-up screen could arrange one, and on teams
   * that have never been arranged — both mean "rotate alphabetically", which
   * is what every stand-up did before this existed.
   */
  standupOrder?: ID[]
}

export interface Person {
  id: ID
  name: string
  role: string
  initials: string
  colorSeed: number
  skills: string[]
  notes: string
  active: boolean
  teamIds: ID[]
  createdAt: number
}

export interface Status {
  id: ID
  name: string
  order: number
  countsAsActive: boolean
  isDone: boolean
  wipLimit: number | null
  stuckAfterDays: number | null
}

export interface Sprint {
  id: ID
  teamId: ID
  name: string
  goal: string
  startDate: string
  endDate: string
  state: 'planned' | 'active' | 'closed'
  closedAt: number | null
}

export interface Task {
  id: ID
  key: string
  teamId: ID
  sprintId: ID | null
  title: string
  description: string
  assigneeId: ID | null
  reviewerId: ID | null
  testerId: ID | null
  statusId: ID
  priority: Priority
  size: number | null
  dueDate: string | null
  project: string | null
  tags: string[]
  orderInColumn: number
  createdAt: number
  updatedAt: number
  statusChangedAt: number
  closedAt: number | null
}

/** Append-only. Never edited; deleted only with its task. */
export interface StatusEvent {
  id: ID
  taskId: ID
  fromStatusId: ID | null
  toStatusId: ID
  at: number
  sprintIdAtTime: ID | null
}

/** Append-only, like StatusEvent. Tells you what was committed up front and what arrived mid-sprint. */
export interface SprintEvent {
  id: ID
  taskId: ID
  fromSprintId: ID | null
  toSprintId: ID | null
  at: number
}

/** What a note turned into, so next retro can show what happened to last retro's list. */
export interface Conversion {
  id: ID
  noteId: ID
  createdType: 'task' | 'followUp'
  createdId: ID
  at: number
}

export interface TaskLink { id: ID; fromTaskId: ID; toTaskId: ID; type: 'blocks' }
export interface ExternalLink { id: ID; taskId: ID; label: string; url: string }

export interface Blocker {
  id: ID
  taskId: ID
  reason: string
  waitingOnType: 'person' | 'team' | 'external' | 'task'
  waitingOnPersonId: ID | null
  waitingOnTaskId: ID | null
  waitingOnText: string | null
  openedAt: number
  resolvedAt: number | null
  resolutionNote: string | null
}

export interface Chase { id: ID; blockerId: ID; at: number; note: string }
export interface Availability { id: ID; personId: ID; sprintId: ID; daysAvailable: number }
export interface Board { id: ID; title: string; scene: unknown; appState: unknown; thumbnail: string | null; createdAt: number; updatedAt: number }
export interface BoardLink { id: ID; boardId: ID; entityType: 'task' | 'sprint' | 'team' | 'process'; entityId: ID }
export type NoteType = 'idea' | 'meeting' | 'retro' | 'oneToOne' | 'improvement'
export interface Note { id: ID; type: NoteType; title: string; body: string; personId: ID | null; sprintId: ID | null; teamId: ID | null; isPrivate: boolean; createdAt: number; updatedAt: number }
export interface FollowUp { id: ID; title: string; dueDate: string | null; personId: ID | null; sprintId: ID | null; sourceNoteId: ID | null; doneAt: number | null; createdAt: number }
export interface Process { id: ID; name: string; boardId: ID | null; steps: unknown[] }
export interface ProcessRun { id: ID; processId: ID; startedAt: number; completedAt: number | null; checks: Record<string, number> }
export interface Standup { id: ID; teamId: ID; sprintId: ID | null; date: string; startedAt: number; endedAt: number | null; personOrder: ID[] }

/**
 * What somebody actually said at a stand-up, in their own words. One per
 * person per stand-up.
 *
 * Deliberately not a Note: those are written by you, about a meeting or a
 * person, and live on the Notes screen. This is a line typed while somebody is
 * still talking, and its whole job is to be on screen again tomorrow.
 *
 * `at` is the stand-up's start, not the moment the text was typed, so "the one
 * before this" stays correct even if a note is edited days later.
 */
export interface StandupNote {
  id: ID
  standupId: ID
  teamId: ID
  personId: ID
  text: string
  date: string
  at: number
}
