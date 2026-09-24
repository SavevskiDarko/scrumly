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
  /** ISO dates nobody works — public holidays, company days off. Read by every working-day count. */
  holidays: string[]
}

export interface Team {
  id: ID
  name: string
  keyPrefix: string
  nextTaskNumber: number
  createdAt: number
  archivedAt: number | null
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

export interface ProgramIncrement {
  id: ID
  name: string
  startDate: string
  endDate: string
  state: 'planning' | 'active' | 'closed'
  teamIds: ID[]
  createdAt: number
  closedAt: number | null
}

/** A team's PI objective. Business value is set by the business owner, 1-10; stretch objectives are uncommitted. */
export interface PiObjective {
  id: ID
  piId: ID
  teamId: ID
  title: string
  businessValue: number
  committed: boolean
  actualValue: number | null
  createdAt: number
}

export type RoamStatus = 'owned' | 'mitigated' | 'accepted' | 'resolved'

export interface PiRisk {
  id: ID
  piId: ID
  description: string
  ownerPersonId: ID | null
  status: RoamStatus
  createdAt: number
}

/** One fist-of-five confidence vote per team per PI. */
export interface PiVote {
  id: ID
  piId: ID
  teamId: ID
  vote: number
  at: number
}

/**
 * Where a KPI's numbers come from. 'manual' is typed in at each check-in; the
 * rest are replayed from the task history, one reading per closed sprint, so
 * nobody copies across a number the app already has.
 */
export type KpiSource = 'manual' | 'points' | 'tasks' | 'reviewed' | 'cycleTime'

/** Something one person has agreed to be measured on. */
export interface Kpi {
  id: ID
  personId: ID
  name: string
  source: KpiSource
  unit: string
  /** Null means watched without a line to hit. */
  target: number | null
  /** Which side of the target is good: review turnaround wants lower, coverage higher. */
  better: 'higher' | 'lower'
  createdAt: number
  /** Retired rather than deleted, so last quarter's goals still have their history. */
  archivedAt: number | null
}

/** One reading of a hand-tracked KPI. At most one per KPI per date. */
export interface KpiEntry {
  id: ID
  kpiId: ID
  date: string
  value: number
  note: string
  at: number
}
