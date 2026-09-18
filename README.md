# Scrumly — the MVP, slices 1 to 5, plus multi-team

A Scrum Master's working surface. Single user, local-first, no server.
Everything lives in IndexedDB in your browser on your machine.

## Running it

    npm install
    npm run dev          # http://localhost:5173

    npm run build        # normal production bundle -> dist/
    npm run build:single # one self-contained HTML file -> dist-single/index.html
    npm test             # smoke tests for the repository layer

Deploy `dist/` to any static host (Cloudflare Pages), or just open
`dist-single/index.html` from disk.

## Slice 1 — the spine

- Dexie schema with every table the roadmap needs, so later slices add
  screens rather than migrations
- The `repo` layer — the only thing allowed to write. `tasks.move` is the
  single function permitted to change a status, and the only writer of
  `statusEvents`
- Backup: export and restore as plain JSON
- First-run setup, teams, people
- Kanban board with drag between and within columns
- Task drawer with assignee, reviewer and tester
- Column configuration: order, which count as active work, stuck
  thresholds, WIP limits

## Slice 2 — what makes it worth opening

- Blockers as a flag, not a column. A blocked task stays where the work
  really is, and carries a reason, who or what it waits on, an age, and a
  chase log
- Blockers screen, oldest first, with open and resolved views. Resolved
  blockers are kept so "we lost twelve days, eight to one vendor" is a
  number rather than an impression
- Today: four counters — blocked, overdue, no assignee, sitting too long
  — each one a link into the board filtered to exactly those tasks
- A queue per active column showing who is holding work there, using the
  reviewer in a review column and the tester in QA rather than whoever
  wrote the code
- Team load, and a sentence about the imbalance when there is one

Added no tables and required no migration: every table went in at v1.

## Slice 3 — fast enough to keep current

- Stand-up mode: one person at a time, their work already on screen,
  arrow keys between people, a timer, and capture that lands on the
  right task while someone is still talking. Ending it shows what
  changed — nothing to write up afterwards
- Follow-ups, pulled forward from slice 5 because a stand-up you cannot
  capture into is pointless. Yours, not the team's; they wait on Today
- Command palette on Cmd/Ctrl-K: tasks, people, and verbs. Written by
  hand rather than pulling in `cmdk`, since it is about eighty lines
- Paste a list: one task per line, same `@ ! ~ #` syntax as the board,
  with a preview that flags names matching nobody before you commit
- The board groups by person as well as status. Dropping a card into
  someone's row makes them answerable for it, using the same
  `ownerFieldFor` rule the reading side uses, so the two can never
  disagree

## Slice 4 — the canvas

Excalidraw, embedded. MIT licensed, and bound arrows, frames, snapping
and export already work, which is most of D10 and D11 on day one.

What is ours on top of it:

- Persistence. Scene written to Dexie on a 700 ms debounce, with a
  thumbnail regenerated at most every 20 seconds
- The boards library, and linking. A board is referenced from many
  places and never copied, so editing it once updates everywhere
- Quick flow: type `Frontend → API → Backend → Database` and get a
  laid-out, connected diagram. Multi-line input stacks into rows
- Present mode: view plus zen mode, zoomed to fit, escape to leave
- Copy to clipboard, and PNG/SVG export
- "New diagram from this task" in the task drawer, pre-named and
  pre-linked

### Two notes on the build

`@excalidraw/mermaid-to-excalidraw` is aliased to a stub in the
single-file build only (`stubs/mermaid-stub.ts`). It drags in mermaid,
cytoscape and katex for one dialog we never use — about four megabytes.
The import is dynamic, so nothing breaks unless that dialog is opened,
and the normal build keeps it as a lazy chunk.

Excalidraw fetches its hand-drawn fonts and its locales lazily from a
CDN. Where that CDN is unreachable it falls back to a system font and
English. The diagrams are unaffected.

## Slice 5 — notes and sprints

- Notes, typed: retro, meeting, one-to-one, idea, improvement. Select a
  line and turn it into either a task for a developer or a follow-up for
  you — the choice is forced at that point, because sending both into
  the backlog is how retro actions die
- Every conversion keeps a link back, so the next retro can show what
  actually happened to the last one's list
- Sprints: goal, two-week dates filled in from the setting, one running
  at a time, close-and-carry-over with each carry logged
- Burndown, scope change and carry-over risk, all replayed from
  `statusEvents` and `sprintEvents` rather than stored. The chart is
  correct for sprints that ran before the screen existed
- Burndown runs over working days, so a two-week sprint burns over ten
  points rather than fourteen

### The first migration

Schema v2 adds two tables: `sprintEvents` (which task joined or left
which sprint, and when) and `conversions` (what a note turned into).
Adding stores only, so Dexie carries every existing row across
untouched. A backup written under v1 still restores — there is a test
for exactly that, because it is the one way this design can lose data. The sidebar lists
them with the slice that brings each one, and the Today screen says
plainly which of its panels are still missing rather than showing
placeholder numbers.

## More than one team

Tasks, sprints and task numbering were scoped to a team from slice 1.
What was not scoped were the *people*: every assignee dropdown, the
board filter avatars, team load, the stand-up running order and the
blocker badge all read a global list, so a second team would have
leaked into all of them. There was also no way to create one.

Now:

- The sidebar switcher lists teams and creates them; Settings manages
  them with member, task and sprint counts
- `people.listActiveForTeam` is the only way a picker gets a list.
  `usePickablePeople` adds anyone already named on the open task, so
  reassigning never silently blanks a person who changed teams
- Somebody can belong to several teams — membership is a multi-entry
  index, toggled per person on the People screen
- Someone in no team is surfaced on the People screen rather than
  vanishing from every board and stand-up
- Stand-up refuses to fall back to "everyone" when a team is empty.
  Running a stand-up for the wrong team is worse than being told the
  team has nobody in it
- A team holding tasks or sprints cannot be deleted
- Notes belong to a team; ones with no team stay visible everywhere

Columns and whiteboards stay shared across teams on purpose: the
workflow and the diagrams are usually yours rather than any one team's.
Say the word if a team should own its own columns.

## Column names carry meaning

`ownerOf` in `src/repo/insights.ts` decides who is answerable for a task
right now: the reviewer in a column whose name contains "review", the
tester in one matching "qa" or "test", otherwise the assignee. Rename
those columns and it falls back to the assignee — wrong, but never
misleading. Making this explicit per column is a settings change worth
doing if you rename them.

## The one rule

Nothing outside `src/repo` writes to the database. Nothing anywhere sets
`task.statusId` except `tasks.move`, and nothing sets `task.sprintId`
except `tasks.setSprint`. Every derived number in the
product — days in a column, stuck lists, carry-over, burndown, cycle
time — is read back out of `statusEvents`. If a write skips that path,
the history is silently wrong and no error tells you.

## Storage

The live database is IndexedDB, in one browser profile on one machine.
That has not changed, and nothing about how the app reads or writes goes
through anything else. What has changed is that it no longer has to be
the only copy.

### The local folder

Settings has a **Local folder** panel. Point it at a directory once and
Scrumly keeps a plain JSON copy of everything there, rewritten a couple
of seconds after anything changes, plus one dated snapshot a day under
`history/` — thirty kept, oldest pruned:

    Scrumly/
      scrumly.json                     the live copy
      history/scrumly-2026-09-18.json  one per day

Choose a folder inside OneDrive, Dropbox or a git repo and you get
off-machine backup and version history without Scrumly knowing anything
about any of them. "Restore from it" reads that file straight back, which
is the path that matters after clearing site data or moving machine.

The trigger is Dexie's own `storagemutated` event — the same signal
`liveQuery` uses to know a screen needs redrawing. Counting rows would
have been cheaper and would have missed every edit that adds or removes
nothing: renaming a sprint, moving a card, resolving a blocker.

The directory handle lives in its own IndexedDB database, `scrumly-local`,
deliberately not in `cadence`. It must never end up inside an export — a
handle means nothing in another browser, and restore would have to strip
it back out.

Permission does not survive a browser restart on its own, so Scrumly asks
again the first time you open it, and says plainly that nothing is being
written until you grant it rather than failing quietly.

This needs the File System Access API, which is Chrome and Edge. Firefox
and Safari get the panel explaining so, and the manual export below it
still works; nothing else about the app differs.

### Everything else

`navigator.storage.persist()` is requested at startup, asking the browser
not to evict the database when the disk gets tight. Browsers can refuse
it, so it lowers the risk rather than removing it — which is exactly why
the folder exists.

Export and restore by hand still work and still produce the same JSON.

## About the name

The app was called Cadence during design. Two things kept the old name
on purpose:

- The IndexedDB database is still `cadence`. Renaming it would not
  migrate anything — the browser would open a new, empty database and
  every task would look deleted. The name is invisible to you.
- Exports now carry `"app": "scrumly"`, but restore still accepts files
  marked `cadence`, so backups taken before the rename keep working.
