import { useLiveQuery } from 'dexie-react-hooks'
import { Suspense, lazy, useEffect, useState } from 'react'
import { AutoSaveProvider } from './components/AutoSaveProvider'
import { Shell } from './components/Shell'
import { requestPersistentStorage } from './repo/fileStore'
import { TaskDrawer } from './components/TaskDrawer'
import { ToastHost } from './components/Toast'
import { db } from './db/schema'
import { useRoute } from './hooks/useRoute'
import { CommandPalette } from './components/CommandPalette'
import { PasteTasks } from './components/PasteTasks'
import { Blockers } from './screens/Blockers'
import { Boards } from './screens/Boards'
import { Notes } from './screens/Notes'
import { Sprints } from './screens/Sprints'
import { Board } from './screens/Board'
import { FirstRun } from './screens/FirstRun'
import { People } from './screens/People'
import { PiPlanning } from './screens/PiPlanning'
import { Settings } from './screens/Settings'
import { Standup } from './screens/Standup'

// The canvas is by far the largest dependency; nothing else should pay for it on startup.
const CanvasEditor = lazy(() => import('./canvas/CanvasEditor'))
import { Today } from './screens/Today'
import { settings as settingsRepo } from './repo'

function Inner() {
  const route = useRoute()
  const [ready, setReady] = useState(false)
  const [palette, setPalette] = useState(false)
  const [paste, setPaste] = useState(false)
  const cfg = useLiveQuery(() => settingsRepo.get(), [])
  // No default: an empty array while the query is still running looks exactly
  // like "no teams yet", which flashed setup at people who were already set up.
  const teams = useLiveQuery(() => db.teams.orderBy('name').toArray(), [])

  useEffect(() => {
    settingsRepo.ensure().then(() => setReady(true))
    // Asks the browser not to evict the database when the disk gets tight.
    // Independent of the backup folder: this one is about silent eviction.
    void requestPersistentStorage()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready || cfg === undefined || teams === undefined) {
    return <div className="empty" style={{ marginTop: 80 }}>Opening your database…</div>
  }

  if (!cfg.setupComplete || teams.length === 0) {
    return <FirstRun onDone={() => { window.location.hash = '#/today' }} />
  }

  const team = teams.find((t) => t.id === cfg.activeTeamId) ?? teams[0]
  const taskId = route.params.get('task')

  let screen: React.ReactNode
  if (route.screen === 'board') screen = <Board teamId={team.id} />
  else if (route.screen === 'blockers') screen = <Blockers teamId={team.id} />
  else if (route.screen === 'people') screen = <People teamId={team.id} />
  else if (route.screen === 'standup') screen = <Standup teamId={team.id} />
  else if (route.screen === 'boards') screen = <Boards />
  else if (route.screen === 'notes') screen = <Notes teamId={team.id} />
  else if (route.screen === 'sprints') screen = <Sprints teamId={team.id} />
  else if (route.screen === 'pi') screen = <PiPlanning />
  else if (route.screen === 'canvas') {
    const boardId = route.params.get('board')
    screen = boardId
      ? (
        <Suspense fallback={<div className="empty" style={{ marginTop: 70 }}>Loading the canvas…</div>}>
          <CanvasEditor boardId={boardId} />
        </Suspense>
      )
      : <Boards />
  }
  else if (route.screen === 'settings') screen = <Settings />
  else screen = <Today teamId={team.id} />

  return (
    <>
      <Shell>{screen}</Shell>
      {taskId && <TaskDrawer taskId={taskId} />}
      {palette && <CommandPalette teamId={team.id} onClose={() => setPalette(false)} onPaste={() => setPaste(true)} />}
      {paste && <PasteTasks teamId={team.id} onClose={() => setPaste(false)} />}
    </>
  )
}

export default function App() {
  return (
    <ToastHost>
      <AutoSaveProvider>
        <Inner />
      </AutoSaveProvider>
    </ToastHost>
  )
}
