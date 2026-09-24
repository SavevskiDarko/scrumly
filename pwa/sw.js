/*
 * Scrumly's service worker, so the browser build installs from Chrome as an
 * app and opens with no connection.
 *
 * This is a template: vite.config.ts fills in the version and the file list at
 * build time and writes it to dist/sw.js. Nothing here runs in dev, in the
 * desktop app, or in the single-file build.
 *
 * Every file in the build is cached on install and served from the cache from
 * then on. A version is complete or absent, never half of one: a new build
 * installs alongside the running one and takes over the next time the app is
 * opened from closed, so an open window never finds its chunks swapped out
 * from under it. Only the app's code lives here; the data is in IndexedDB and
 * a service worker update never touches it.
 */

const VERSION = '__VERSION__'
const FILES = __FILES__
const CACHE = `scrumly-${VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('scrumly-') && k !== CACHE).map((k) => caches.delete(k))),
    ),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Routes live in the hash, so every page load is the one index.html.
  const key = req.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : url.href
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(key, { ignoreSearch: req.mode === 'navigate' }))
      .then((hit) => hit ?? fetch(req)),
  )
})
