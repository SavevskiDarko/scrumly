#!/usr/bin/env node
/**
 * Runs the desktop app against the Vite dev server, with hot reload.
 *
 *   npm run app
 *
 * Electron has to be pointed at a URL that is already serving, so this starts
 * Vite, waits for it to answer, and only then opens the window. Doing it here
 * rather than with `concurrently` and `wait-on` keeps two dependencies out of
 * the tree for about forty lines.
 *
 * The port is picked rather than assumed: 5173 is often already taken by
 * another copy of the dev server, and a desktop window pointed at somebody
 * else's server is a confusing way to spend ten minutes.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PREFERRED = Number(process.env.PORT) || 5173

function bindable(port, host) {
  return new Promise((resolve) => {
    const probe = createServer()
    // No such interface is not the same as somebody already on it.
    probe.once('error', (err) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

/**
 * Vite binds to `localhost`, which is ::1 on Windows and 127.0.0.1 elsewhere.
 * Probing only one of the two reports a port free that Vite then cannot have.
 */
async function free(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (!(await bindable(port, host))) return false
  }
  return true
}

async function pickPort() {
  for (let port = PREFERRED; port < PREFERRED + 40; port++) {
    if (await free(port)) return port
  }
  throw new Error(`No free port between ${PREFERRED} and ${PREFERRED + 40}`)
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`The dev server never answered on ${url}`)
}

const port = await pickPort()
const url = `http://localhost:${port}`
if (port !== PREFERRED) console.log(`Port ${PREFERRED} was busy — using ${port}.`)

const children = []
function stopAll(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}
process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))

const vite = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'dev', '--', '--port', String(port), '--strictPort'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
)
children.push(vite)
vite.on('exit', (code) => { if (code) stopAll(code) })

await waitForServer(url)

const app = spawn(electron, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SCRUMLY_DEV_URL: url },
})
children.push(app)

// Closing the window ends the session; leaving Vite running afterwards just
// holds the port for the next run.
app.on('exit', (code) => stopAll(code ?? 0))
