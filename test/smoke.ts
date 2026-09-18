import 'fake-indexeddb/auto'
import { db } from '../src/db/schema'
import {
  backup, blockedDays, blockers, boards, buildIndex, cycleTimeOf, filterByBucket,
  flowStats, followUps, groupWaitingOn, loadByPerson, ownerFieldFor, ownerOf,
  parseQuickAdd, people, queues, rotate, notes, settings, sprints, sprintStats,
  standups, statuses, tasks, teams, velocity, workingDays, addDays, nextWeekday,
} from '../src/repo'
import { flowSkeleton, looksLikeFlow, parseFlow } from '../src/canvas/quickFlow'
import { fileStore, historyName, prunable } from '../src/repo/fileStore'

let failures = 0
function check(label: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ok   ${label}`)
  else { console.log(`  FAIL ${label} ${extra}`); failures++ }
}

async function run() {
  await settings.ensure()
  const cols = await statuses.createDefaults()
  const todo = cols.find((s) => s.name === 'To do')!
  const progress = cols.find((s) => s.name === 'In progress')!
  const done = cols.find((s) => s.name === 'Done')!

  const team = await teams.create({ name: 'Team A' })
  check('prefix derived from name', team.keyPrefix === 'TA', team.keyPrefix)

  const elena = await people.create({ name: 'Elena Petrova', role: 'Developer', teamIds: [team.id] })
  check('initials from full name', elena.initials === 'EP', elena.initials)
  const made = await people.createFromList('Stefan, QA\nJakim, Developer\n\n', [team.id])
  check('paste-a-list creates two people', made.length === 2)

  const t1 = await tasks.create({ teamId: team.id, statusId: todo.id, title: 'Rate limit on /charges' })
  const t2 = await tasks.create({ teamId: team.id, statusId: todo.id, title: 'Webhook signature docs' })
  check('keys increment per team', t1.key === 'TA-1' && t2.key === 'TA-2', `${t1.key} ${t2.key}`)
  check('creation writes a status event', (await tasks.history(t1.id)).length === 1)
  check('second card ordered after the first', t2.orderInColumn > t1.orderInColumn)

  await tasks.move(t2.id, progress.id, null)
  const h2 = await tasks.history(t2.id)
  check('move appends an event', h2.length === 2 && h2[1].fromStatusId === todo.id && h2[1].toStatusId === progress.id)

  await tasks.move(t2.id, progress.id, null)
  check('same-column move does not fake a status change', (await tasks.history(t2.id)).length === 2)

  await tasks.move(t2.id, done.id, null)
  check('entering a done column stamps closedAt', (await db.tasks.get(t2.id))!.closedAt !== null)
  await tasks.move(t2.id, progress.id, null)
  check('leaving it clears closedAt again', (await db.tasks.get(t2.id))!.closedAt === null)

  const t3 = await tasks.create({ teamId: team.id, statusId: todo.id, title: 'Third' })
  await tasks.move(t3.id, todo.id, t1.id)
  const col = await tasks.listForColumn(team.id, todo.id)
  check('insert-before reorders within a column', col[0].id === t3.id && col[1].id === t1.id, col.map((c) => c.title).join(' | '))

  let guarded = false
  try { await tasks.update(t1.id, { statusId: done.id } as never) } catch { guarded = true }
  check('update refuses to change status behind move()', guarded)

  const p = parseQuickAdd('Seed refund accounts @nadica !high ~3 #qa #data')
  check('quick-add parses all four markers',
    p.title === 'Seed refund accounts' && p.assigneeName === 'nadica' && p.priority === 'high' && p.size === 3 && p.tags.join(',') === 'qa,data',
    JSON.stringify(p))

  const snap = await backup.snapshot()
  check('snapshot carries tasks and their history', snap.tables.tasks.length === 3 && snap.tables.statusEvents.length >= 5)

  await tasks.remove(t1.id)
  check('deleting a task clears its events', (await db.statusEvents.where('taskId').equals(t1.id).count()) === 0)

  const restored = await backup.restore(snap)
  check('restore puts the deleted task back', restored.ok && (await db.tasks.count()) === 3)

  const bad = await backup.restore({ app: 'something-else' })
  check('restore rejects a foreign file', !bad.ok)

  const blocked = await statuses.remove(todo.id)
  check('a column with tasks cannot be removed', !blocked.ok, blocked.reason ?? '')


  // ---------- slice 2: blockers and derived signals ----------
  console.log('\n  -- slice 2 --')
  const cols2 = await statuses.list()
  const review = cols2.find((s) => /review/i.test(s.name))!
  const backlog = cols2[0]
  const everyone = await people.list()
  const elenaP = everyone.find((p) => p.name.startsWith('Elena'))!
  const jakimP = everyone.find((p) => p.name.startsWith('Jakim'))!

  const rebuild = async () =>
    buildIndex(await statuses.list(), await people.list(), await blockers.listOpen())

  const bt = await tasks.create({ teamId: team.id, statusId: progress.id, title: 'Card tokenisation', assigneeId: jakimP.id })
  const b1 = await blockers.open(bt.id, { reason: 'Vendor sandbox will not replay', waitingOnType: 'external', waitingOnText: 'vendor #4471' })
  const again = await blockers.open(bt.id, { reason: 'Edited reason', waitingOnType: 'external' })
  check('a task has at most one open blocker', again.id === b1.id)
  check('blocker starts at zero days', blockedDays(b1) === 0)

  await blockers.chase(b1.id, 'emailed support')
  await blockers.chase(b1.id, 'called')
  check('chases accumulate', (await blockers.chasesFor(b1.id)).length === 2)

  let ix = await rebuild()
  check('blocked bucket finds it', filterByBucket(await tasks.listForTeam(team.id), ix, 'blocked').map((t) => t.id).join() === bt.id)

  const overdueTask = await tasks.create({ teamId: team.id, statusId: progress.id, title: 'Long overdue', dueDate: '2020-01-01' })
  const backlogTask = await tasks.create({ teamId: team.id, statusId: backlog.id, title: 'Someday' })
  ix = await rebuild()
  const all2 = await tasks.listForTeam(team.id)
  check('overdue bucket', filterByBucket(all2, ix, 'overdue').some((t) => t.id === overdueTask.id))
  check('unowned counts work outside the backlog', filterByBucket(all2, ix, 'unowned').some((t) => t.id === overdueTask.id))
  check('unowned ignores the backlog column', !filterByBucket(all2, ix, 'unowned').some((t) => t.id === backlogTask.id))

  // simulate a card that has not moved for a week
  await db.tasks.update(overdueTask.id, { statusChangedAt: Date.now() - 8 * 86_400_000 })
  ix = await rebuild()
  check('stuck bucket uses the per-column threshold',
    filterByBucket(await tasks.listForTeam(team.id), ix, 'stuck').some((t) => t.id === overdueTask.id))

  const reviewTask = await tasks.create({
    teamId: team.id, statusId: review.id, title: 'Invoice rounding',
    assigneeId: jakimP.id, reviewerId: elenaP.id,
  })
  ix = await rebuild()
  check('a review column answers with the reviewer, not the author',
    ownerOf(reviewTask, review, ix)?.id === elenaP.id)
  check('other columns fall back to the assignee',
    ownerOf(bt, progress, ix)?.id === jakimP.id)

  const loads = loadByPerson(await tasks.listForTeam(team.id), await people.list(), ix)
  const elenaLoad = loads.find((l) => l.person.id === elenaP.id)!
  const jakimLoad = loads.find((l) => l.person.id === jakimP.id)!
  check('review work counts against the reviewer', elenaLoad.active.some((t) => t.id === reviewTask.id))
  check('blocked work is counted separately', jakimLoad.blocked === 1, String(jakimLoad.blocked))

  const qs = queues(await tasks.listForTeam(team.id), await statuses.list(), ix)
  check('a queue exists per active column with work in it', qs.some((q) => q.status.id === review.id))

  await blockers.resolve(b1.id, 'vendor shipped a replay endpoint')
  check('resolving empties the open list', (await blockers.listOpen()).length === 0)
  check('resolved blockers are kept', (await blockers.listResolved()).length === 1)
  ix = await rebuild()
  check('the card stops reading as blocked', filterByBucket(await tasks.listForTeam(team.id), ix, 'blocked').length === 0)
  check('the task never left its real column', (await db.tasks.get(bt.id))!.statusId === progress.id)


  // ---------- slice 3: stand-up, capture, bulk entry ----------
  console.log('\n  -- slice 3 --')
  check('running order rotates', rotate(['a', 'b', 'c'], 1).join('') === 'bca')
  check('rotation wraps past the end', rotate(['a', 'b', 'c'], 4).join('') === 'bca')
  check('a single person is left alone', rotate(['a'], 3).join('') === 'a')

  check('a review column makes the reviewer answerable', ownerFieldFor(review) === 'reviewerId')
  check('an unrecognised column falls back to the assignee', ownerFieldFor(progress) === 'assigneeId')

  const qaCol = cols2.find((s) => /qa/i.test(s.name))!
  check('a QA column makes the tester answerable', ownerFieldFor(qaCol) === 'testerId')

  const dragged = await tasks.create({ teamId: team.id, statusId: progress.id, title: 'Dragged around' })
  await tasks.move(dragged.id, review.id, null)
  await tasks.setOwnerFor(dragged.id, ownerFieldFor(review), elenaP.id)
  const afterDrag = (await db.tasks.get(dragged.id))!
  check('dropping into a row in a review column sets the reviewer',
    afterDrag.reviewerId === elenaP.id && afterDrag.assigneeId === null)

  const session = await standups.start(team.id)
  check('a stand-up lines everyone up', session.personOrder.length === (await people.list()).filter((p) => p.active).length)
  check('a stand-up starts unfinished', session.endedAt === null)

  const before = await tasks.listForTeam(team.id)
  await tasks.move(before[0].id, review.id, null)
  await blockers.open(dragged.id, { reason: 'waiting on design', waitingOnType: 'person', waitingOnPersonId: jakimP.id })
  await followUps.create({ title: 'Talk to Jakim about load', personId: jakimP.id })
  const summary = await standups.summary(session)
  check('the summary counts what moved during the meeting', summary.moved >= 1, String(summary.moved))
  check('the summary counts blockers raised', summary.blockersOpened === 1, String(summary.blockersOpened))
  check('the summary counts follow-ups', summary.followUps === 1, String(summary.followUps))

  await standups.end(session.id)
  check('ending stamps the finish time', (await db.standups.get(session.id))!.endedAt !== null)

  const fu = (await followUps.listOpen())[0]
  await followUps.complete(fu.id)
  check('completing a follow-up clears it from the open list', (await followUps.listOpen()).length === 0)
  check('completed follow-ups are kept', (await followUps.listDone()).length === 1)

  const lines = ['Dispute handling @Elena !high', 'Partial refunds ~5 #billing', '   ', 'Retry dashboard @nobody']
  const parsedLines = lines.map((l) => parseQuickAdd(l)).filter((x) => x.title)
  check('blank lines are dropped from a pasted list', parsedLines.length === 3)
  check('a pasted line keeps its priority', parsedLines[0].priority === 'high')
  const peopleNow = await people.list()
  const matched = peopleNow.find((p) => p.name.toLowerCase().startsWith(parsedLines[0].assigneeName!.toLowerCase()))
  check('a pasted @name matches a real person', matched?.id === elenaP.id)
  const unmatched = peopleNow.find((p) => p.name.toLowerCase().startsWith(parsedLines[2].assigneeName!.toLowerCase()))
  check('an unknown @name matches nobody rather than guessing', unmatched === undefined)


  // ---------- slice 4: the canvas ----------
  console.log('\n  -- slice 4 --')
  check('an arrow chain splits on the unicode arrow',
    parseFlow('Frontend → API → Backend → Database')[0].join('|') === 'Frontend|API|Backend|Database')
  check('ascii arrows work too', parseFlow('a -> b --> c')[0].join('|') === 'a|b|c')
  check('each line becomes its own row', parseFlow('a → b\nc → d → e').length === 2)
  check('blank lines are ignored', parseFlow('a → b\n\n\nc → d').length === 2)
  check('a single word is not a flow', !looksLikeFlow('Frontend'))
  check('two words joined by an arrow are', looksLikeFlow('Frontend → API'))

  const flow = flowSkeleton(parseFlow('Request → Validation → Processing → Payment → Response'))
  const rects = flow.elements.filter((e) => e.type === 'rectangle')
  const arrows = flow.elements.filter((e) => e.type === 'arrow')
  check('five steps make five boxes', rects.length === 5, String(rects.length))
  check('and four arrows between them', arrows.length === 4, String(arrows.length))
  check('every arrow is bound at both ends',
    arrows.every((a) => (a as { start?: unknown; end?: unknown }).start && (a as { end?: unknown }).end))
  check('boxes do not overlap',
    rects.every((r, i) => i === 0 || (r.x as number) > (rects[i - 1].x as number) + (rects[i - 1].width as number)))
  check('a two-line flow stacks downwards', (() => {
    const two = flowSkeleton(parseFlow('a → b\nc → d'))
    const boxes = two.elements.filter((e) => e.type === 'rectangle')
    return (boxes[2].y as number) > (boxes[0].y as number)
  })())

  const board = await boards.create('Payment retry flow')
  check('a new board starts empty', Array.isArray(board.scene) && (board.scene as unknown[]).length === 0)

  const scene = flowSkeleton(parseFlow('Frontend → API')).elements
  await boards.save(board.id, scene, { zoom: { value: 1 } })
  const reloaded = (await boards.get(board.id))!
  check('a scene survives a round trip through the database',
    (reloaded.scene as unknown[]).length === scene.length)
  check('saving bumps the edited time', reloaded.updatedAt >= board.updatedAt)

  const someTask = (await tasks.listForTeam(team.id))[0]
  await boards.link(board.id, 'task', someTask.id)
  await boards.link(board.id, 'task', someTask.id)
  check('linking the same board twice does not duplicate', (await boards.linksFor(board.id)).length === 1)
  check('a task finds its diagrams', (await boards.forEntity('task', someTask.id)).map((b) => b.id).join() === board.id)

  const second = await tasks.listForTeam(team.id)
  await boards.link(board.id, 'task', second[1].id)
  check('one board can explain several tasks', (await boards.linksFor(board.id)).length === 2)
  check('the board is referenced, never copied', (await db.boards.count()) === 1)

  await boards.remove(board.id)
  check('deleting a board clears its links', (await db.boardLinks.count()) === 0)
  check('and the board itself', (await db.boards.count()) === 0)


  // ---------- slice 5: notes and sprints ----------
  console.log('\n  -- slice 5 --')
  check('dates advance across a month boundary', addDays('2026-01-31', 1) === '2026-02-01')
  const week = workingDays('2026-09-14', '2026-09-27') // Mon to the Sunday two weeks later
  check('a two-week sprint is ten working days', week.length === 10, String(week.length))
  check('weekends are left out', !week.includes('2026-09-19') && !week.includes('2026-09-20'))

  const sp1 = await sprints.plan({ teamId: team.id, lengthDays: 14, startDate: '2026-09-14' })
  check('a planned sprint is named in sequence', sp1.name === 'Sprint 1', sp1.name)
  check('the end date follows the length', sp1.endDate === '2026-09-27', sp1.endDate)
  check('a new sprint is not running yet', sp1.state === 'planned')

  const started = await sprints.activate(sp1.id)
  check('activating works', started.ok)
  const sp2 = await sprints.plan({ teamId: team.id, lengthDays: 14 })
  const clash = await sprints.activate(sp2.id)
  check('a second sprint cannot run at the same time', !clash.ok, clash.reason ?? '')

  const pool = await tasks.listForTeam(team.id)
  const committedTask = pool[0]
  const lateTask = pool[1]
  await tasks.setSprint(committedTask.id, sp1.id)
  check('joining a sprint is logged', (await db.sprintEvents.where('taskId').equals(committedTask.id).count()) === 1)
  await tasks.setSprint(committedTask.id, sp1.id)
  check('re-setting the same sprint logs nothing new', (await db.sprintEvents.where('taskId').equals(committedTask.id).count()) === 1)

  // backdate the first join to before the sprint opened, leave the second as "arrived late"
  const joinEvent = (await db.sprintEvents.where('taskId').equals(committedTask.id).toArray())[0]
  await db.sprintEvents.update(joinEvent.id, { at: new Date('2026-09-14T09:00:00').getTime() })
  await tasks.setSprint(lateTask.id, sp1.id)

  const readStats = async () => sprintStats(
    (await sprints.get(sp1.id))!,
    await tasks.listForTeam(team.id),
    await db.statusEvents.toArray(),
    await db.sprintEvents.toArray(),
    await statuses.list(),
  )

  let st = await readStats()
  check('the sprint holds both tasks', st.total === 2, String(st.total))
  check('one counts as committed up front', st.committed === 1, String(st.committed))
  check('the other as added after it started', st.addedAfterStart === 1, String(st.addedAfterStart))
  check('the ideal line starts at the full total', st.series[0].ideal === 2, String(st.series[0].ideal))
  check('and reaches zero on the last day', st.series[st.series.length - 1].ideal === 0)
  check('nothing is burned down yet', st.series[st.series.length - 1].remaining === 2)

  const doneCol = (await statuses.list()).find((x) => x.isDone)!
  await tasks.move(committedTask.id, doneCol.id, null)
  st = await readStats()
  check('finishing a task burns it down', st.series[st.series.length - 1].remaining === 1)
  check('and counts as done', st.done === 1)

  await tasks.setSprint(lateTask.id, null)
  st = await readStats()
  check('pulling a task out is counted as removed', st.removed === 1, String(st.removed))

  const leftover = await tasks.create({ teamId: team.id, statusId: progress.id, title: 'Unfinished business' })
  await tasks.setSprint(leftover.id, sp1.id)
  await sprints.close(sp1.id, sp2.id, [leftover.id])
  check('closing marks the sprint closed', (await sprints.get(sp1.id))!.state === 'closed')
  check('carried tasks land in the next sprint', (await db.tasks.get(leftover.id))!.sprintId === sp2.id)
  check('and the carry is logged too',
    (await db.sprintEvents.where('taskId').equals(leftover.id).toArray()).some((e) => e.toSprintId === sp2.id))

  const note = await notes.create({ type: 'retro', title: 'Sprint 1 retrospective', teamId: team.id })
  await notes.update(note.id, { body: 'Improve the QA handover process\nAdd a smoke test step' })
  const toTask = await notes.convert(note.id, '- Add a smoke test step', 'task', { teamId: team.id, statusId: backlog.id })
  check('a retro line becomes a task', toTask.ok && Boolean(toTask.label))
  check('list markers are stripped from the title',
    (await db.tasks.get(toTask.id!))!.title === 'Add a smoke test step')
  const toFu = await notes.convert(note.id, 'Improve the QA handover process', 'followUp', {})
  check('and another becomes a follow-up', toFu.ok)
  check('the follow-up remembers where it came from',
    (await db.followUps.get(toFu.id!))!.sourceNoteId === note.id)
  check('both conversions are recorded against the note', (await notes.conversionsFor(note.id)).length === 2)
  const emptyConvert = await notes.convert(note.id, '   ', 'followUp', {})
  check('converting nothing is refused', !emptyConvert.ok)

  // A backup written before the v2 migration must still restore.
  const modern = await backup.snapshot()
  const legacy = JSON.parse(JSON.stringify(modern))
  legacy.schemaVersion = 1
  delete legacy.tables.sprintEvents
  delete legacy.tables.conversions
  const legacyRestore = await backup.restore(legacy)
  check('a backup from before the migration still restores', legacyRestore.ok, legacyRestore.error ?? '')
  check('and the new tables come back empty rather than broken', (await db.sprintEvents.count()) === 0)
  const future = await backup.restore({ app: 'scrumly', schemaVersion: 99, tables: {} })
  check('a backup from a newer version is refused', !future.ok)
  const foreign = await backup.restore({ app: 'some-other-tool', schemaVersion: 1, tables: {} })
  check('a file from another app is refused', !foreign.ok)

  const renamed = JSON.parse(JSON.stringify(await backup.snapshot()))
  check('exports carry the new name', renamed.app === 'scrumly', renamed.app)
  renamed.app = 'cadence'
  const oldName = await backup.restore(renamed)
  check('a backup written under the old name still restores', oldName.ok, oldName.error ?? '')


  // ---------- slice 6: more than one team ----------
  console.log('\n  -- two teams --')
  const teamB = await teams.create({ name: 'Team B' })
  check('a second team gets its own prefix', teamB.keyPrefix === 'TB', teamB.keyPrefix)

  const bTask = await tasks.create({ teamId: teamB.id, statusId: progress.id, title: 'Team B work' })
  check('task numbering is per team, not global', bTask.key === 'TB-1', bTask.key)
  check("team A's board does not show team B's work",
    !(await tasks.listForTeam(team.id)).some((t) => t.id === bTask.id))

  const shared = await people.create({ name: 'Shared Person', role: 'Tech lead', teamIds: [team.id] })
  check('a new person starts in one team', (await people.listForTeam(teamB.id)).length === 0)
  await people.toggleTeam(shared.id, teamB.id)
  check('somebody can belong to two teams at once',
    (await people.listForTeam(teamB.id)).some((p) => p.id === shared.id) &&
    (await people.listForTeam(team.id)).some((p) => p.id === shared.id))
  await people.toggleTeam(shared.id, teamB.id)
  check('and can be taken back out of one', (await people.listForTeam(teamB.id)).length === 0)

  const aMembers = await people.listActiveForTeam(team.id)
  check("a picker for team A never offers team B's people",
    aMembers.every((p) => p.teamIds.includes(team.id)))

  await people.setTeams(shared.id, [])
  check('someone in no team is findable rather than invisible',
    (await people.listOrphans()).some((p) => p.id === shared.id))
  await people.setTeams(shared.id, [team.id])

  await blockers.open(bTask.id, { reason: 'other team blocker', waitingOnType: 'external' })
  const aOpen = await blockers.openForTeam(team.id)
  const bOpen = await blockers.openForTeam(teamB.id)
  check("team A's blocker count ignores team B", !aOpen.some((x) => x.taskId === bTask.id))
  check("and team B's finds its own", bOpen.some((x) => x.taskId === bTask.id))

  const bSprint = await sprints.plan({ teamId: teamB.id, lengthDays: 14 })
  check('sprint numbering restarts per team', bSprint.name === 'Sprint 1', bSprint.name)
  await sprints.activate(bSprint.id)
  check('each team can have its own sprint running at once',
    (await sprints.active(team.id))?.id !== (await sprints.active(teamB.id))?.id ||
    (await sprints.active(team.id)) === undefined)

  const refusedDelete = await teams.remove(teamB.id)
  check('a team holding work cannot be deleted', !refusedDelete.ok, refusedDelete.reason ?? '')
  const empty = await teams.create({ name: 'Temp Team' })
  const removed = await teams.remove(empty.id)
  check('an empty one can be', removed.ok, removed.reason ?? '')
  const lastOne = await db.teams.count()
  check('teams survived the removal', lastOne === 2, String(lastOne))

  const standupB = await standups.start(teamB.id)
  check('a stand-up for an empty team lines up nobody rather than everybody',
    standupB.personOrder.length === 0, String(standupB.personOrder.length))


  // ---------- regressions ----------
  // Each of these is a bug that shipped and was found by reading, not by a
  // failing test. They are here so the next change cannot quietly undo them.
  console.log('\n  -- regressions --')

  const rTeam = await teams.create({ name: 'Regression Team' })
  const rCols = await statuses.list()
  const rTodo = rCols.find((s) => s.name === 'To do') ?? rCols[1]
  const rDone = rCols.find((s) => s.isDone)!

  // Deleting a task used to leave its chases, sprint log and diagram links behind.
  const doomed = await tasks.create({ teamId: rTeam.id, statusId: rTodo.id, title: 'About to be deleted' })
  const doomedBlocker = await blockers.open(doomed.id, { reason: 'waiting', waitingOnType: 'external' })
  await blockers.chase(doomedBlocker.id, 'first chase')
  await blockers.chase(doomedBlocker.id, 'second chase')
  const doomedSprint = await sprints.plan({ teamId: rTeam.id, lengthDays: 14 })
  await tasks.setSprint(doomed.id, doomedSprint.id)
  const doomedBoard = await boards.create('Doomed diagram')
  await boards.link(doomedBoard.id, 'task', doomed.id)
  const doomedNote = await notes.create({ type: 'retro', title: 'Regression retro', teamId: rTeam.id })
  const doomedConv = await notes.convert(doomedNote.id, 'Something to do', 'task', { teamId: rTeam.id, statusId: rTodo.id })

  await tasks.remove(doomed.id)
  check('deleting a task takes its chases with it',
    (await db.chases.where('blockerId').equals(doomedBlocker.id).count()) === 0)
  check('and its sprint history', (await db.sprintEvents.where('taskId').equals(doomed.id).count()) === 0)
  check('and any diagram pinned to it',
    (await db.boardLinks.where('entityId').equals(doomed.id).count()) === 0)
  check('and the board itself is left alone', Boolean(await boards.get(doomedBoard.id)))
  await tasks.remove(doomedConv.id!)
  check('deleting a converted task clears the note conversion too',
    (await notes.conversionsFor(doomedNote.id)).length === 0)

  // Carrying work into the next sprint is not the same as pulling it out.
  const carryFrom = await sprints.plan({ teamId: rTeam.id, lengthDays: 14, startDate: '2026-09-14' })
  const carryTo = await sprints.plan({ teamId: rTeam.id, lengthDays: 14 })
  await sprints.activate(carryFrom.id)
  const carried = await tasks.create({ teamId: rTeam.id, statusId: rTodo.id, title: 'Carried forward' })
  const pulled = await tasks.create({ teamId: rTeam.id, statusId: rTodo.id, title: 'Pulled out mid-sprint' })
  await tasks.setSprint(carried.id, carryFrom.id)
  await tasks.setSprint(pulled.id, carryFrom.id)
  await tasks.setSprint(pulled.id, null)

  const statsFor = async (id: string) => sprintStats(
    (await sprints.get(id))!,
    await tasks.listForTeam(rTeam.id),
    await db.statusEvents.toArray(),
    await db.sprintEvents.toArray(),
    await statuses.list(),
  )

  check('work pulled out mid-sprint counts as removed', (await statsFor(carryFrom.id)).removed === 1,
    String((await statsFor(carryFrom.id)).removed))
  await sprints.close(carryFrom.id, carryTo.id, [carried.id])
  check('but carrying work over at close does not',
    (await statsFor(carryFrom.id)).removed === 1, String((await statsFor(carryFrom.id)).removed))
  check('closing still routes the carry through setSprint',
    (await db.tasks.get(carried.id))!.sprintId === carryTo.id)
  check('and still logs it', (await db.sprintEvents.where('taskId').equals(carried.id).toArray())
    .some((e) => e.fromSprintId === carryFrom.id && e.toSprintId === carryTo.id))

  // The burndown counts points, and an unsized task is worth one.
  const ptSprint = await sprints.plan({ teamId: rTeam.id, lengthDays: 14, startDate: '2026-09-14' })
  const big = await tasks.create({ teamId: rTeam.id, statusId: rTodo.id, title: 'Eight pointer', size: 8 })
  const small = await tasks.create({ teamId: rTeam.id, statusId: rTodo.id, title: 'Three pointer', size: 3 })
  const unsized = await tasks.create({ teamId: rTeam.id, statusId: rTodo.id, title: 'Nobody sized this' })
  for (const t of [big, small, unsized]) await tasks.setSprint(t.id, ptSprint.id)
  let pts = await statsFor(ptSprint.id)
  check('the sprint totals points, not cards', pts.points === 12, String(pts.points))
  check('an unsized task is worth one point', pts.total === 3 && pts.points === 12)
  check('the ideal line starts at the point total', pts.series[0].ideal === 12, String(pts.series[0].ideal))
  check('nothing is burned down yet', pts.series[pts.series.length - 1].remaining === 12)
  await tasks.move(big.id, rDone.id, null)
  pts = await statsFor(ptSprint.id)
  check('finishing an eight-pointer burns eight, not one',
    pts.series[pts.series.length - 1].remaining === 4, String(pts.series[pts.series.length - 1].remaining))
  check('and points done tracks it', pts.pointsDone === 8, String(pts.pointsDone))

  // Setup must not be able to lay down a second set of columns.
  const columnsBefore = (await statuses.list()).length
  await statuses.ensureDefaults()
  check('running setup twice does not double the columns',
    (await statuses.list()).length === columnsBefore,
    `${columnsBefore} -> ${(await statuses.list()).length}`)

  // Follow-ups: ticking one used to be the end of it, because nothing called
  // listDone, reopen or remove. Today reads all four now.
  const fu1 = await followUps.create({ title: 'Talk to Elena about the vendor' })
  const fu2 = await followUps.create({ title: 'Typo  in this  one' })
  await followUps.complete(fu1.id)
  check('a completed follow-up leaves the open list',
    !(await followUps.listOpen()).some((f) => f.id === fu1.id))
  check('and is findable again rather than gone',
    (await followUps.listDone()).some((f) => f.id === fu1.id))
  await followUps.reopen(fu1.id)
  check('reopening puts it back', (await followUps.listOpen()).some((f) => f.id === fu1.id))
  check('and clears the done stamp', (await db.followUps.get(fu1.id))!.doneAt === null)
  await followUps.rename(fu2.id, '  Fixed wording  ')
  check('renaming trims what you typed', (await db.followUps.get(fu2.id))!.title === 'Fixed wording')
  await followUps.rename(fu2.id, '   ')
  check('and refuses to blank the title', (await db.followUps.get(fu2.id))!.title === 'Fixed wording')
  await followUps.remove(fu2.id)
  check('deleting one really removes it', (await db.followUps.get(fu2.id)) === undefined)

  // ---------- velocity, cycle time, and where the days went ----------
  console.log('\n  -- analytics --')

  const vTeam = await teams.create({ name: 'Velocity Team' })
  const vCols = await statuses.list()
  const vTodo = vCols.find((s) => s.name === 'To do') ?? vCols[1]
  const vProg = vCols.find((s) => s.countsAsActive)!
  const vDone = vCols.find((s) => s.isDone)!

  const vSprint = await sprints.plan({ teamId: vTeam.id, lengthDays: 14, startDate: '2026-09-14' })
  const vNext = await sprints.plan({ teamId: vTeam.id, lengthDays: 14 })
  await sprints.activate(vSprint.id)

  const shipped = await tasks.create({ teamId: vTeam.id, statusId: vTodo.id, title: 'Shipped it', size: 5 })
  const alsoShipped = await tasks.create({ teamId: vTeam.id, statusId: vTodo.id, title: 'Also shipped', size: 2 })
  const notShipped = await tasks.create({ teamId: vTeam.id, statusId: vTodo.id, title: 'Ran out of time', size: 3 })
  for (const t of [shipped, alsoShipped, notShipped]) await tasks.setSprint(t.id, vSprint.id)
  for (const t of [shipped, alsoShipped]) {
    await tasks.move(t.id, vProg.id, null)
    await tasks.move(t.id, vDone.id, null)
  }
  await tasks.move(notShipped.id, vProg.id, null)
  // Closing carries the unfinished one out, which is exactly the case that
  // breaks any velocity read from current sprint membership.
  await sprints.close(vSprint.id, vNext.id, [notShipped.id])

  const readVelocity = async () => velocity(
    (await sprints.listForTeam(vTeam.id)).filter((s) => s.state === 'closed'),
    await tasks.listForTeam(vTeam.id),
    await db.statusEvents.toArray(),
    await statuses.list(),
  )
  let vel = await readVelocity()
  check('velocity counts the points a sprint delivered', vel[0]?.points === 7, JSON.stringify(vel[0]))
  check('and the tasks behind them', vel[0]?.tasks === 2, String(vel[0]?.tasks))
  check('unfinished work carried out does not count as delivered',
    vel[0]!.points === 7 && (await db.tasks.get(notShipped.id))!.sprintId === vNext.id)

  // Finishing it in the NEXT sprint must not backdate into the closed one.
  await tasks.move(notShipped.id, vDone.id, null)
  vel = await readVelocity()
  check('finishing it later credits the sprint it was in, not the closed one',
    vel[0]!.points === 7, String(vel[0]!.points))

  const vIx = buildIndex(await statuses.list(), await people.list(), await blockers.listOpen())
  const vFlow = flowStats(await tasks.listForTeam(vTeam.id), await db.statusEvents.toArray(), vIx, 0)
  check('cycle time samples the finished work', vFlow.sampled === 3, String(vFlow.sampled))
  check('and reports a median', vFlow.medianDays !== null && vFlow.medianDays >= 0)

  const madeAndDone = await tasks.create({ teamId: vTeam.id, statusId: vTodo.id, title: 'Never worked on' })
  await tasks.move(madeAndDone.id, vDone.id, null)
  const skipFlow = flowStats(await tasks.listForTeam(vTeam.id), await db.statusEvents.toArray(), vIx, 0)
  check('work that never passed through an active column is not counted',
    skipFlow.sampled === 3, String(skipFlow.sampled))

  const handmade = [
    { toStatusId: vTodo.id, at: 0 },
    { toStatusId: vProg.id, at: 2 * 86_400_000 },
    { toStatusId: vDone.id, at: 5 * 86_400_000 },
  ]
  check('cycle time starts at real work, not at creation',
    cycleTimeOf(handmade, vIx) === 3, String(cycleTimeOf(handmade, vIx)))

  // Days lost, grouped by what the work was waiting on.
  const bTeam = await teams.create({ name: 'Blocker Team' })
  const mk = async (title: string) =>
    tasks.create({ teamId: bTeam.id, statusId: vTodo.id, title })
  const one = await mk('Vendor one'); const two = await mk('Vendor two'); const three = await mk('Design')
  const bOne = await blockers.open(one.id, { reason: 'x', waitingOnType: 'external', waitingOnText: 'Vendor A' })
  const bTwo = await blockers.open(two.id, { reason: 'y', waitingOnType: 'external', waitingOnText: 'vendor a' })
  const bThree = await blockers.open(three.id, { reason: 'z', waitingOnType: 'external', waitingOnText: 'Design' })
  await db.blockers.update(bOne.id, { openedAt: Date.now() - 5 * 86_400_000 })
  await db.blockers.update(bTwo.id, { openedAt: Date.now() - 3 * 86_400_000 })
  await db.blockers.update(bThree.id, { openedAt: Date.now() - 1 * 86_400_000 })

  const bRows = (await blockers.listOpen()).filter((b) => [bOne.id, bTwo.id, bThree.id].includes(b.id))
  const grouped = groupWaitingOn(bRows, (b) => b.waitingOnText || 'Something')
  check('the same vendor spelled two ways is one group', grouped.length === 2, String(grouped.length))
  check('the worst offender comes first', grouped[0].days === 8, String(grouped[0].days))
  check('and carries how many tasks it held up', grouped[0].count === 2, String(grouped[0].count))
  check('open blockers are counted as still running', grouped[0].stillOpen === 2)
  await blockers.resolve(bOne.id)
  const afterResolve = groupWaitingOn(
    (await blockers.listOpen()).concat(await blockers.listResolved())
      .filter((b) => [bOne.id, bTwo.id].includes(b.id)),
    (b) => b.waitingOnText || 'Something',
  )
  check('resolved ones keep their days but stop counting as open',
    afterResolve[0].count === 2 && afterResolve[0].stillOpen === 1,
    JSON.stringify(afterResolve[0]))

  // Sprint name and dates are editable by hand, so the guards matter.
  const eTeam = await teams.create({ name: 'Editable Team' })
  const eSprint = await sprints.plan({ teamId: eTeam.id, lengthDays: 14, startDate: '2026-09-14' })
  check('a sprint can be renamed',
    (await sprints.update(eSprint.id, { name: 'Payments hardening' })).ok &&
    (await sprints.get(eSprint.id))!.name === 'Payments hardening')
  await sprints.update(eSprint.id, { name: '   Trimmed   ' })
  check('the new name is trimmed', (await sprints.get(eSprint.id))!.name === 'Trimmed')

  const blankName = await sprints.update(eSprint.id, { name: '  ' })
  check('a sprint cannot be left nameless', !blankName.ok, blankName.reason ?? '')
  check('and keeps the name it had', (await sprints.get(eSprint.id))!.name === 'Trimmed')

  check('both dates can be set by hand',
    (await sprints.update(eSprint.id, { startDate: '2026-10-05', endDate: '2026-10-23' })).ok)
  const moved = (await sprints.get(eSprint.id))!
  check('and they stick', moved.startDate === '2026-10-05' && moved.endDate === '2026-10-23')
  check('the burndown follows the new range',
    workingDays(moved.startDate, moved.endDate).length === 15,
    String(workingDays(moved.startDate, moved.endDate).length))

  // Moving the start past the end drags the sprint along rather than refusing.
  const slid = await sprints.update(eSprint.id, { startDate: '2026-11-09' })
  const afterSlide = (await sprints.get(eSprint.id))!
  check('moving the start past the end moves the whole sprint', slid.ok)
  check('and keeps the length it had',
    afterSlide.startDate === '2026-11-09' && afterSlide.endDate === '2026-11-27',
    `${afterSlide.startDate} to ${afterSlide.endDate}`)
  await sprints.update(eSprint.id, { startDate: '2026-10-05', endDate: '2026-10-23' })
  const shortened = await sprints.update(eSprint.id, { startDate: '2026-10-12' })
  check('but moving it within the range just shortens it',
    shortened.ok && (await sprints.get(eSprint.id))!.endDate === '2026-10-23')

  const backwards = await sprints.update(eSprint.id, { endDate: '2026-09-01' })
  check('a sprint cannot end before it starts', !backwards.ok, backwards.reason ?? '')
  check('and the old dates survive the refusal',
    (await sprints.get(eSprint.id))!.endDate === '2026-10-23'
    && (await sprints.get(eSprint.id))!.startDate === '2026-10-12')
  const weekendOnly = await sprints.update(eSprint.id, { startDate: '2026-10-10', endDate: '2026-10-11' })
  check('a range with no working days in it is refused', !weekendOnly.ok, weekendOnly.reason ?? '')

  const byDates = await sprints.plan({
    teamId: eTeam.id, lengthDays: 14, startDate: '2026-11-02', endDate: '2026-11-06',
  })
  check('planning with explicit dates ignores the length',
    byDates.startDate === '2026-11-02' && byDates.endDate === '2026-11-06',
    `${byDates.startDate} to ${byDates.endDate}`)

  // sprintStartWeekday is read now rather than stored and ignored.
  const wedTeam = await teams.create({ name: 'Wednesday Team' })
  const wed = await sprints.plan({ teamId: wedTeam.id, lengthDays: 14, startWeekday: 3 })
  check('a sprint can start on the weekday you chose',
    new Date(`${wed.startDate}T12:00:00`).getDay() === 3, wed.startDate)

  // ---------- the folder copy ----------
  console.log('\n  -- local folder --')

  check('a day gets one dated snapshot',
    historyName(new Date(2026, 8, 18)) === 'scrumly-2026-09-18.json', historyName(new Date(2026, 8, 18)))
  check('and it is zero-padded so the names sort by date',
    historyName(new Date(2026, 0, 5)) === 'scrumly-2026-01-05.json', historyName(new Date(2026, 0, 5)))

  const dated = (n: number) => Array.from({ length: n }, (_, i) =>
    `scrumly-2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}.json`)
  check('nothing is pruned while under the limit', prunable(dated(30), 30).length === 0)
  check('the oldest go first once over it',
    prunable(dated(33), 30).join() === 'scrumly-2026-01-01.json,scrumly-2026-01-02.json,scrumly-2026-01-03.json',
    prunable(dated(33), 30).join())
  check('nothing that is not a dated snapshot is ever touched',
    prunable(['scrumly.json', 'notes.txt', '.DS_Store', ...dated(33)], 0)
      .every((n) => /^scrumly-\d{4}-\d{2}-\d{2}\.json$/.test(n)))
  check('the live file is never a pruning candidate',
    !prunable(['scrumly.json', ...dated(40)], 1).includes('scrumly.json'))

  // A round trip through a stand-in for the folder, so the write path is
  // exercised without a real directory picker.
  const written = new Map<string, string>()
  const fakeDir = (store: Map<string, string>, children = new Map<string, unknown>()): never => ({
    name: 'Scrumly',
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (text: string) => { store.set(name, text) },
        close: async () => {},
      }),
      getFile: async () => ({ text: async () => store.get(name) ?? '' }),
    }),
    getDirectoryHandle: async (name: string) => {
      if (!children.has(name)) children.set(name, fakeDir(store))
      return children.get(name)
    },
    keys: async function* () { for (const k of store.keys()) yield k },
    removeEntry: async (name: string) => { store.delete(name) },
  }) as never

  const folderSnap = await backup.snapshot()
  await fileStore.write(fakeDir(written), folderSnap, new Date(2026, 8, 18))
  check('the live file is written', written.has('scrumly.json'))
  check('and a dated one alongside it', written.has('scrumly-2026-09-18.json'))
  check('what lands on disk is the real snapshot',
    JSON.parse(written.get('scrumly.json')!).tables.tasks.length === folderSnap.tables.tasks.length)
  const roundTripped = await fileStore.readLive(fakeDir(written))
  check('and it reads back as a restorable backup',
    (await backup.restore(roundTripped)).ok)

  // The dates setup promises are the dates plan() produces.
  const previewStart = nextWeekday(new Date(), 1)
  const previewEnd = addDays(previewStart, 14 - 1)
  const planned = await sprints.plan({ teamId: rTeam.id, lengthDays: 14, startDate: previewStart })
  check('the sprint length shown at setup is the one you get',
    planned.endDate === previewEnd, `${planned.endDate} vs ${previewEnd}`)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((e) => { console.error(e); process.exit(1) })
