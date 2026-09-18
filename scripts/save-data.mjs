#!/usr/bin/env node
/**
 * Commits whatever Scrumly has written into this repo, and pushes it.
 *
 * The Local folder setting keeps scrumly.json current within seconds of any
 * change, but nothing commits it — the working tree just sits there showing a
 * modified file. This is the other half: run it when you want a point you can
 * come back to.
 *
 *   npm run save              commit and push
 *   npm run save -- --no-push commit only
 *
 * Safe to run when nothing has changed; it says so and stops.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Wherever the folder was pointed: the repo root, or a data/ folder inside it. */
const CANDIDATES = ['scrumly.json', 'history', 'data/scrumly.json', 'data/history']

function describe(paths) {
  const file = paths.find((p) => p.endsWith('scrumly.json'))
  if (!file) return 'data'
  try {
    const snap = JSON.parse(readFileSync(join(root, file), 'utf8'))
    const n = (t) => snap.tables?.[t]?.length ?? 0
    const open = (snap.tables?.blockers ?? []).filter((b) => b.resolvedAt === null).length
    const parts = [
      `${n('tasks')} task${n('tasks') === 1 ? '' : 's'}`,
      `${n('sprints')} sprint${n('sprints') === 1 ? '' : 's'}`,
    ]
    if (open) parts.push(`${open} open blocker${open === 1 ? '' : 's'}`)
    return parts.join(', ')
  } catch {
    return 'data'
  }
}

try {
  git('rev-parse', '--git-dir')
} catch {
  console.error('Not a git repository. Run this from inside the Scrumly repo.')
  process.exit(1)
}

const present = CANDIDATES.filter((p) => existsSync(join(root, p)))
if (present.length === 0) {
  console.error(
    'No Scrumly data found in this repo.\n\n' +
    'Open Settings, then Local folder, and point it at:\n  ' + root + '\n\n' +
    'Once it has written scrumly.json, run this again.',
  )
  process.exit(1)
}

git('add', '--', ...present)

// --cached against HEAD: tells us whether the add actually staged anything.
let staged = ''
try {
  staged = git('diff', '--cached', '--name-only', '--', ...present)
} catch {
  staged = ''
}
if (!staged) {
  console.log('Nothing new to save — the committed copy already matches what is on disk.')
  process.exit(0)
}

const stamp = new Date().toISOString().slice(0, 10)
const message = `Data: ${describe(present)} — ${stamp}`
git('commit', '-m', message, '--', ...present)
console.log(`Committed  ${message}`)
for (const line of staged.split('\n')) console.log(`  ${line}`)

if (process.argv.includes('--no-push')) {
  console.log('\nNot pushed (--no-push).')
  process.exit(0)
}

let upstream = ''
try {
  upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
} catch {
  console.log('\nNo upstream branch, so nothing was pushed. Commit is safe locally.')
  process.exit(0)
}

try {
  execFileSync('git', ['push'], { cwd: root, stdio: 'inherit' })
  console.log(`Pushed to ${upstream}.`)
} catch {
  console.error(
    `\nCommitted, but the push to ${upstream} failed. Your data is safe in the local\n` +
    'repository — run `git push` yourself once the connection or sign-in is sorted.',
  )
  process.exit(1)
}
