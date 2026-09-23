import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Writes dist/sw.js from pwa/sw.js once the build is on disk, with every file
 * in the build listed for precaching and a version that is a hash of their
 * contents, so any change to the build is a new service worker.
 */
function serviceWorker(): Plugin {
  let outDir = ''
  return {
    name: 'scrumly-sw',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    transformIndexHtml: () => [
      { tag: 'link', attrs: { rel: 'manifest', href: './manifest.webmanifest' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'icon', href: './icon.svg', type: 'image/svg+xml' }, injectTo: 'head' },
      { tag: 'link', attrs: { rel: 'apple-touch-icon', href: './icon-192.png' }, injectTo: 'head' },
    ],
    closeBundle() {
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .filter((f) => f !== 'sw.js')
        .sort()
      const hash = createHash('sha256')
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)))
      const template = readFileSync(fileURLToPath(new URL('./pwa/sw.js', import.meta.url)), 'utf8')
      writeFileSync(join(outDir, 'sw.js'), template
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__FILES__', JSON.stringify(['./', ...files.map((f) => `./${f}`)], null, 2)))
    },
  }
}

export default defineConfig(({ mode }) => {
  const single = mode === 'single'
  return {
    // Relative, so the built bundle works wherever it is served from: a static
    // host at a sub-path, and the desktop app's app:// origin, which resolves
    // an absolute /assets/... against the scheme root rather than the app.
    base: './',
    // The manifest, icons and service worker are for the hosted build. A single
    // file opened from disk can be neither installed nor served by a worker.
    publicDir: single ? false : 'public',
    plugins: [react(), ...(single ? [viteSingleFile()] : [serviceWorker()])],
    define: { 'process.env.IS_PREACT': JSON.stringify('false') },
    resolve: {
      alias: single
        ? { '@excalidraw/mermaid-to-excalidraw': fileURLToPath(new URL('./stubs/mermaid-stub.ts', import.meta.url)) }
        : {},
    },
    build: {
      outDir: single ? 'dist-single' : 'dist',
      target: 'es2020',
      chunkSizeWarningLimit: 2000,
    },
  }
})
