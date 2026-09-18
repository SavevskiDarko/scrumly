import { Excalidraw, convertToExcalidrawElements, exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../components/Toast'
import { db } from '../db/schema'
import { useDarkMode } from '../hooks/useDarkMode'
import { go, setParam } from '../hooks/useRoute'
import { boards as boardRepo, saveBinaryFile, saveTextFile } from '../repo'
import { flowSkeleton, looksLikeFlow, parseFlow } from './quickFlow'

type Api = {
  updateScene: (d: { elements?: readonly unknown[] }) => void
  getSceneElements: () => readonly unknown[]
  getAppState: () => Record<string, unknown>
  getFiles: () => Record<string, unknown>
  scrollToContent: (t?: unknown, o?: unknown) => void
}

const SAVE_DEBOUNCE = 700
const THUMB_COOLDOWN = 20_000

export default function CanvasEditor({ boardId }: { boardId: string }) {
  const toast = useToast()
  const dark = useDarkMode()
  const apiRef = useRef<Api | null>(null)
  const saveTimer = useRef<number | null>(null)
  const lastThumb = useRef(0)
  const [presenting, setPresenting] = useState(false)
  const [flow, setFlow] = useState('')
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')

  const board = useLiveQuery(() => boardRepo.get(boardId), [boardId])
  const links = useLiveQuery(() => boardRepo.linksFor(boardId), [boardId], [])
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], [])
  /** The edit waiting to be written, tagged with the board it was drawn on. */
  const pending = useRef<{ boardId: string; scene: readonly unknown[]; appState: Record<string, unknown> } | null>(null)

  const makeThumb = useCallback(async () => {
    const api = apiRef.current
    if (!api) return
    try {
      const elements = api.getSceneElements()
      if (!elements.length) { await boardRepo.setThumbnail(boardId, null); return }
      const blob = await exportToBlob({
        elements: elements as never,
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff' } as never,
        files: api.getFiles() as never,
        mimeType: 'image/png',
        exportPadding: 12,
        maxWidthOrHeight: 320,
      })
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result))
        r.onerror = () => rej(new Error('x'))
        r.readAsDataURL(blob)
      })
      await boardRepo.setThumbnail(boardId, dataUrl)
    } catch {
      /* a missing preview is not worth interrupting anyone over */
    }
  }, [boardId])

  /** Writes whatever is waiting, to the board it was actually drawn on. */
  const flush = useCallback(async () => {
    if (saveTimer.current) { window.clearTimeout(saveTimer.current); saveTimer.current = null }
    const p = pending.current
    if (!p) return
    pending.current = null
    await boardRepo.save(p.boardId, p.scene, p.appState)
    setSaved('saved')
  }, [])

  const onChange = useCallback((elements: readonly unknown[], appState: Record<string, unknown>) => {
    pending.current = {
      boardId,
      scene: elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom,
      },
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    setSaved('saving')
    saveTimer.current = window.setTimeout(async () => {
      await flush()
      if (Date.now() - lastThumb.current > THUMB_COOLDOWN) {
        lastThumb.current = Date.now()
        void makeThumb()
      }
    }, SAVE_DEBOUNCE)
  }, [boardId, flush, makeThumb])

  /**
   * Leaving the board — or switching to another one — writes the pending edit
   * instead of dropping it. Cancelling the timer here is how the last 700 ms of
   * drawing used to disappear on a navigation.
   */
  useEffect(() => {
    setSaved('idle')
    lastThumb.current = 0
    return () => { void flush() }
  }, [boardId, flush])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && presenting) { e.preventDefault(); setPresenting(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presenting])

  function drawFlow() {
    const api = apiRef.current
    if (!api || !flow.trim()) return
    const rows = parseFlow(flow)
    if (!rows.length) return
    const existing = api.getSceneElements()
    const skeleton = flowSkeleton(rows, { x: 120, y: 120 + existing.length * 4 }, `qf${Date.now().toString(36)}`)
    const made = convertToExcalidrawElements(skeleton.elements as never)
    api.updateScene({ elements: [...existing, ...made] })
    api.scrollToContent(made as never, { fitToContent: true })
    setFlow('')
    toast(`Drew ${rows.flat().length} boxes`)
  }

  async function exportImage(kind: 'png' | 'svg') {
    const api = apiRef.current
    if (!api) return
    const elements = api.getSceneElements()
    if (!elements.length) { toast('Nothing on the canvas yet', true); return }
    const name = (board?.title ?? 'diagram').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()
    const common = {
      elements: elements as never,
      appState: { exportBackground: true, exportPadding: 20, viewBackgroundColor: '#ffffff' } as never,
      files: api.getFiles() as never,
    }
    try {
      if (kind === 'png') {
        const blob = await exportToBlob({ ...common, mimeType: 'image/png', exportPadding: 20 })
        const ok = await saveBinaryFile(`${name}.png`, blob)
        toast(ok ? 'PNG saved' : 'Saving files is blocked here — try the local build', !ok)
      } else {
        const svg = await exportToSvg({ ...common, exportPadding: 20 })
        const text = new XMLSerializer().serializeToString(svg)
        const ok = await saveTextFile(`${name}.svg`, text)
        toast(ok ? 'SVG saved' : 'Saving files is blocked here — try the local build', !ok)
      }
    } catch {
      toast('Export failed', true)
    }
  }

  async function copyImage() {
    const api = apiRef.current
    if (!api) return
    try {
      const blob = await exportToBlob({
        elements: api.getSceneElements() as never,
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff' } as never,
        files: api.getFiles() as never,
        mimeType: 'image/png',
        exportPadding: 20,
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toast('Copied — paste it into Slack or a ticket')
    } catch {
      toast('Clipboard blocked here. Export a PNG instead.', true)
    }
  }

  if (board === undefined) return <div className="empty" style={{ marginTop: 70 }}>Opening the board…</div>
  if (!board) return <div className="empty" style={{ marginTop: 70 }}><strong>That board is gone</strong>It may have been deleted.</div>
  // Switching boards keeps this component mounted, so the query can still be
  // holding the previous one. Rendering that would hand Excalidraw the wrong
  // scene, and the next edit would save it over this board.
  if (board.id !== boardId) return <div className="empty" style={{ marginTop: 70 }}>Opening the board…</div>

  const linkedTasks = links
    .filter((l) => l.entityType === 'task')
    .map((l) => tasks.find((t) => t.id === l.entityId))
    .filter(Boolean)

  return (
    <>
      {!presenting && (
        <div className="topbar">
          <button className="btn ghost sm" onClick={() => go('boards')}>← Boards</button>
          <input
            className="inline-input"
            style={{ width: 240, fontWeight: 650, fontSize: 14 }}
            defaultValue={board.title}
            key={board.id}
            onBlur={(e) => boardRepo.rename(board.id, e.target.value)}
          />
          {linkedTasks.map((t) => (
            <button key={t!.id} className="chip btn-like" onClick={() => setParam('task', t!.id)}>{t!.key}</button>
          ))}
          <span className="small faint">
            {saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : ''}
          </span>
          <span className="spacer" />
          <div className="flow-input">
            <input
              className="input"
              placeholder="Frontend → API → Backend → Database"
              value={flow}
              onChange={(e) => setFlow(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') drawFlow() }}
            />
            <button className="btn sm" disabled={!looksLikeFlow(flow)} onClick={drawFlow}>Draw</button>
          </div>
          <button className="btn" onClick={copyImage}>Copy</button>
          <button className="btn" onClick={() => exportImage('png')}>PNG</button>
          <button className="btn" onClick={() => exportImage('svg')}>SVG</button>
          <button className="btn primary" onClick={() => {
            setPresenting(true)
            setTimeout(() => apiRef.current?.scrollToContent(undefined, { fitToContent: true }), 60)
          }}>Present</button>
        </div>
      )}

      <div className={`canvas-stage${presenting ? ' presenting' : ''}`}>
        {presenting && (
          <button className="btn exit-present" onClick={() => setPresenting(false)}>Exit — esc</button>
        )}
        <Excalidraw
          excalidrawAPI={(api: unknown) => { apiRef.current = api as Api }}
          initialData={{
            elements: (board.scene as never) ?? [],
            appState: { ...(board.appState as object), viewModeEnabled: false },
            scrollToContent: true,
          }}
          onChange={onChange as never}
          viewModeEnabled={presenting}
          zenModeEnabled={presenting}
          theme={dark ? 'dark' : 'light'}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } }}
          key={boardId}
        />
      </div>
    </>
  )
}
