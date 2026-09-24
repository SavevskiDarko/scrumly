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
  /**
   * The order stand-ups run in, when it has been arranged by hand. Absent on
   * teams created before the Stand-up screen could arrange one, and on teams
   * that have never been arranged — both mean "rotate alphabetically", which
   * is what every stand-up did before this existed.
   */
  standupOrder?: ID[]
  /** Set when this team mirrors a Jira board. Absent for every team that does not. */
  jira?: JiraLink
  /**
   * Kept on this computer only: this team and everything that hangs off it are
   * never synced, exported or written to the data folder (src/repo/localOnly.ts).
   * Absent on every team nobody has asked that of.
   */
  localOnly?: boolean
}

/**
 * Which Jira board a team mirrors, and how. No credentials in here, ever: this
 * row is synced and backed up, and the token lives only in the desktop app's
 * encrypted store.
 */
export interface JiraLink {
  /** The Jira base URL the board belongs to. A pull refuses to run against any other site. */
  site: string
  boardId: number
  boardName: string
  /** Jira status id -> Scrumly column id, for statuses mapped by hand. The rest are matched by name or category. */
  statusMap: Record<string, ID>
  /** Also bring in the issues sitting in the board's backlog, not just those in sprints. */
  includeBacklog: boolean
  /** Pull on start-up and every few minutes while the desktop app is open. */
  auto: boolean
  lastPull: { at: number; ok: boolean; message: string } | null
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
  /** Jira's id for this person (accountId on Cloud, username on Server), once an import has matched them. */
  jiraId?: string
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
  /** The Jira sprint this mirrors. Jira owns it: a pull overwrites anything changed here. */
  jira?: { id: number }
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
  /**
   * The Jira issue this mirrors. Jira owns its title, status, sprint, assignee,
   * size and dates; reviewer, tester, blockers and dependencies are Scrumly's
   * own and survive every pull.
   */
  jira?: { id: string; key: string }
}

/**
 * Append-only. Never edited; deleted only with its task. The one exception is
 * a task imported from Jira, whose history is a replay of Jira's changelog and
 * is rebuilt from it on every pull.
 */
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
