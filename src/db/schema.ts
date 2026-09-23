import Dexie, { type Table } from 'dexie'
import type {
  Availability, Blocker, Board, BoardLink, Chase, Conversion, ExternalLink, FollowUp,
  Note, Person, PiObjective, PiRisk, PiVote, Process, ProcessRun, ProgramIncrement, Settings,
  Sprint, SprintEvent, Standup, Status, StatusEvent, Task, TaskLink, Team,
} from './types'

export const SCHEMA_VERSION = 3

export class ScrumlyDB extends Dexie {
  settings!: Table<Settings, number>
  teams!: Table<Team, string>
  people!: Table<Person, string>
  statuses!: Table<Status, string>
  sprints!: Table<Sprint, string>
  tasks!: Table<Task, string>
  statusEvents!: Table<StatusEvent, string>
  taskLinks!: Table<TaskLink, string>
  externalLinks!: Table<ExternalLink, string>
  blockers!: Table<Blocker, string>
  chases!: Table<Chase, string>
  availability!: Table<Availability, string>
  boards!: Table<Board, string>
  boardLinks!: Table<BoardLink, string>
  notes!: Table<Note, string>
  followUps!: Table<FollowUp, string>
  processes!: Table<Process, string>
  processRuns!: Table<ProcessRun, string>
  standups!: Table<Standup, string>
  sprintEvents!: Table<SprintEvent, string>
  conversions!: Table<Conversion, string>
  programIncrements!: Table<ProgramIncrement, string>
  piObjectives!: Table<PiObjective, string>
  piRisks!: Table<PiRisk, string>
  piVotes!: Table<PiVote, string>

  constructor() {
    // The IndexedDB database is still called 'cadence' — the app's first name.
    // Renaming it would not migrate anything: the browser would simply open a
    // new, empty database and every task, blocker and diagram would look gone.
    // The name is invisible to you, so it stays.
    super('cadence')
    // v1 — every table the roadmap needs exists now, even where no screen uses it.
    // Empty tables cost nothing; adding them later would cost a migration.
    this.version(1).stores({
      settings: 'id',
      teams: 'id, name',
      people: 'id, name, active, *teamIds',
      statuses: 'id, order',
      sprints: 'id, teamId, state, startDate',
      tasks: 'id, key, teamId, sprintId, statusId, assigneeId, reviewerId, testerId, dueDate, [teamId+statusId]',
      statusEvents: 'id, taskId, at, toStatusId',
      taskLinks: 'id, fromTaskId, toTaskId',
      externalLinks: 'id, taskId',
      blockers: 'id, taskId, resolvedAt',
      chases: 'id, blockerId',
      availability: 'id, personId, sprintId',
      boards: 'id, updatedAt',
      boardLinks: 'id, boardId, entityId',
      notes: 'id, type, personId, sprintId, updatedAt',
      followUps: 'id, doneAt, dueDate',
      processes: 'id',
      processRuns: 'id, processId',
      standups: 'id, teamId, date',
    })

    // v2 — sprint membership history and note conversions.
    // Adding stores only: Dexie carries every existing row across untouched.
    this.version(2).stores({
      sprintEvents: 'id, taskId, at, toSprintId',
      conversions: 'id, noteId, createdId',
    })

    // v3 — PI Planning: a program increment spans several teams' sprints,
    // each with its own objectives, ROAM risks, and confidence votes.
    this.version(3).stores({
      programIncrements: 'id, startDate, state, *teamIds',
      piObjectives: 'id, piId, teamId',
      piRisks: 'id, piId, status',
      piVotes: 'id, piId, teamId, [piId+teamId]',
    })
  }
}

export const db = new ScrumlyDB()

export const ALL_TABLE_NAMES = [
  'settings', 'teams', 'people', 'statuses', 'sprints', 'tasks', 'statusEvents',
  'taskLinks', 'externalLinks', 'blockers', 'chases', 'availability', 'boards',
  'boardLinks', 'notes', 'followUps', 'processes', 'processRuns', 'standups',
  'sprintEvents', 'conversions', 'programIncrements', 'piObjectives', 'piRisks', 'piVotes',
] as const
