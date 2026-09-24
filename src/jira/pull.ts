import { db } from '../db/schema'
import type { ID } from '../db/types'
import { jiraBridge, type JiraBridge } from '../desktop/bridge'
import {
  CLOSED_SPRINTS_KEPT, applyImport, jiraLinks, jiraTime, planImport, tasksToRecheck,
  type ImportResult, type JiraBoard, type JiraBoardConfig, type JiraHistory, type JiraIssue, type JiraPull,
  type JiraSprint, type JiraStatus,
} from '../repo/jira'
import { settings } from '../repo/settings'

class JiraError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const withQuery = (path: string, extra: string) => `${path}${path.includes('?') ? '&' : '?'}${extra}`

function client(bridge: JiraBridge) {
  async function get<T>(path: string): Promise<T> {
    const r = await bridge.get<T>(path)
    if (!r.ok) throw new JiraError(r.message, r.status)
    return r.data
  }

  /** Board and sprint lists: { values, isLast }. */
  async function values<T>(path: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 0; page < 200; page++) {
      const r = await get<{ values?: T[]; isLast?: boolean }>(withQuery(path, `startAt=${out.length}&maxResults=50`))
      const got = r.values ?? []
      out.push(...got)
      if (r.isLast !== false || got.length === 0) break
    }
    return out
  }

  /** Issue lists: { issues, total }. */
  async function issues(path: string): Promise<JiraIssue[]> {
    const out: JiraIssue[] = []
    for (let page = 0; page < 200; page++) {
      const r = await get<{ issues?: JiraIssue[]; total?: number }>(withQuery(path, `startAt=${out.length}&maxResults=100`))
      const got = r.issues ?? []
      out.push(...got)
      if (got.length === 0 || out.length >= (r.total ?? 0)) break
    }
    return out
  }

  /**
   * Search results carry at most the latest 100 changes per issue. Anything
   * longer is fetched in full, or the replay would start halfway through.
   * Cloud pages the changelog; Server only returns it whole on the issue.
   */
  async function fullChangelog(issue: JiraIssue): Promise<JiraIssue> {
    const log = issue.changelog
    if (!log || (log.total ?? 0) <= log.histories.length) return issue
    try {
      const histories: JiraHistory[] = []
      for (let page = 0; page < 50; page++) {
        const r = await get<{ values?: JiraHistory[]; isLast?: boolean }>(
          `/rest/api/2/issue/${issue.id}/changelog?startAt=${histories.length}&maxResults=100`,
        )
        histories.push(...(r.values ?? []))
        if (r.isLast !== false || !r.values?.length) break
      }
      return { ...issue, changelog: { total: histories.length, histories } }
    } catch (err) {
      if (!(err instanceof JiraError) || err.status !== 404) throw err
      const whole = await get<JiraIssue>(`/rest/api/2/issue/${issue.id}?expand=changelog&fields=status`)
      return { ...issue, changelog: whole.changelog }
    }
  }

  return { get, values, issues, fullChangelog }
}

/** Scrum boards, optionally filtered by name. Kanban boards have no sprints to bring in. */
export async function searchBoards(name: string, bridge = jiraBridge()): Promise<JiraBoard[]> {
  if (!bridge) return []
  const q = name.trim() ? `&name=${encodeURIComponent(name.trim())}` : ''
  const r = await bridge.get<{ values?: JiraBoard[] }>(`/rest/agile/1.0/board?type=scrum&maxResults=50${q}`)
  if (!r.ok) throw new Error(r.message)
  return r.data.values ?? []
}

/** What the status-mapping list needs: the board's columns and every status's name. */
export async function boardStatuses(boardId: number, bridge = jiraBridge()) {
  if (!bridge) return null
  const api = client(bridge)
  const [config, statuses] = await Promise.all([
    api.get<JiraBoardConfig>(`/rest/agile/1.0/board/${boardId}/configuration`),
    api.get<JiraStatus[]>('/rest/api/2/status'),
  ])
  return { config, statuses }
}

export interface PullOutcome extends Partial<ImportResult> { ok: boolean; message: string }

const running = new Set<ID>()

/**
 * One pull of one team's board. Never throws: the outcome is also written to
 * the team's link, so every device can see when it last worked and why not.
 */
export async function pullTeam(teamId: ID, bridge = jiraBridge()): Promise<PullOutcome> {
  if (!bridge) return { ok: false, message: 'Jira import runs in the desktop app' }
  if (running.has(teamId)) return { ok: false, message: 'Already pulling' }
  running.add(teamId)

  const finish = async (outcome: PullOutcome) => {
    await jiraLinks.update(teamId, { lastPull: { at: Date.now(), ok: outcome.ok, message: outcome.message } })
    return outcome
  }

  try {
    const team = await db.teams.get(teamId)
    const link = team?.jira
    if (!team || !link) return { ok: false, message: 'This team is not linked to a Jira board' }
    const connection = await bridge.status()
    if (!connection.connected) return finish({ ok: false, message: 'The desktop app is not connected to Jira' })
    if (connection.site !== link.site) {
      return finish({ ok: false, message: `This team follows a board on ${link.site}, but the app is connected to ${connection.site}` })
    }
    const columns = await db.statuses.orderBy('order').toArray()
    if (!columns.length) return finish({ ok: false, message: 'Add some board columns first' })

    const api = client(bridge)
    const boardId = link.boardId
    const [config, statuses, allSprints] = await Promise.all([
      api.get<JiraBoardConfig>(`/rest/agile/1.0/board/${boardId}/configuration`),
      api.get<JiraStatus[]>('/rest/api/2/status'),
      api.values<JiraSprint>(`/rest/agile/1.0/board/${boardId}/sprint?state=active,future,closed`),
    ])

    // A board can show sprints that belong to another board. Those are that
    // team's sprints, not this one's.
    const own = allSprints.filter((s) => s.originBoardId == null || s.originBoardId === boardId)
    const closed = own
      .filter((s) => s.state === 'closed')
      .sort((a, b) => (jiraTime(a.completeDate ?? a.endDate) ?? 0) - (jiraTime(b.completeDate ?? b.endDate) ?? 0))
      .slice(-CLOSED_SPRINTS_KEPT)
    const sprints = [...closed, ...own.filter((s) => s.state === 'active'), ...own.filter((s) => s.state === 'future')]

    const pointsField = config.estimation?.field?.fieldId
    const fields = ['summary', 'description', 'status', 'assignee', 'priority', 'duedate', 'labels',
      'created', 'updated', 'sprint', 'closedSprints', ...(pointsField ? [pointsField] : [])].join(',')

    let issues: JiraIssue[] = []
    for (const s of sprints) {
      issues.push(...await api.issues(`/rest/agile/1.0/sprint/${s.id}/issue?fields=${fields}&expand=changelog`))
    }
    if (link.includeBacklog) {
      issues.push(...await api.issues(`/rest/agile/1.0/board/${boardId}/backlog?fields=${fields}&expand=changelog`))
    }
    issues = await Promise.all(issues.map((i) => api.fullChangelog(i)))

    const teamTasks = await db.tasks.where('teamId').equals(teamId).toArray()
    const teamSprints = await db.sprints.where('teamId').equals(teamId).toArray()
    const pulledSprintIds = new Set(teamSprints.filter((s) => s.jira && sprints.some((js) => js.id === s.jira!.id)).map((s) => s.id))
    const rechecked: JiraPull['rechecked'] = []
    for (const t of tasksToRecheck(teamTasks, new Set(issues.map((i) => i.id)), pulledSprintIds, link.includeBacklog)) {
      try {
        const issue = await api.get<JiraIssue>(`/rest/api/2/issue/${t.jira!.id}?fields=${fields}&expand=changelog`)
        rechecked.push({ id: t.jira!.id, issue: await api.fullChangelog(issue) })
      } catch (err) {
        // Gone from Jira, or moved somewhere this token cannot see: either way
        // it is no longer this board's work.
        if (err instanceof JiraError && (err.status === 404 || err.status === 403)) rechecked.push({ id: t.jira!.id, issue: null })
        else throw err
      }
    }

    const cfg = await settings.get()
    const plan = planImport({ sprints, issues, statuses, config, rechecked }, {
      teamId, link, columns,
      people: await db.people.toArray(),
      tasks: teamTasks,
      sprints: teamSprints,
      sprintLengthDays: cfg.sprintLengthDays,
      now: Date.now(),
    })
    const result = await applyImport(plan)

    const changed = result.written + result.deleted + result.removedTasks
    const message = changed === 0
      ? `Up to date — ${plan.sprints.length} sprints, ${plan.tasks.length} issues`
      : `${plan.sprints.length} sprints and ${plan.tasks.length} issues; ${changed} change${changed === 1 ? '' : 's'}`
    return finish({ ok: true, message, ...result })
  } catch (err) {
    return finish({ ok: false, message: err instanceof Error ? err.message : 'The pull failed' })
  } finally {
    running.delete(teamId)
  }
}

/** Every linked team set to pull on its own. Used on start-up and on a timer. */
export async function pullAutomatic(bridge = jiraBridge()): Promise<void> {
  if (!bridge) return
  const connection = await bridge.status()
  if (!connection.connected) return
  for (const team of await db.teams.toArray()) {
    if (team.jira?.auto && team.jira.site === connection.site) await pullTeam(team.id, bridge)
  }
}
