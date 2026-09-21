import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  const single = mode === 'single'
  return {
    // Relative, so the built bundle works wherever it is served from: a static
    // host at a sub-path, and the desktop app's app:// origin, which resolves
    // an absolute /assets/... against the scheme root rather than the app.
    base: './',
    plugins: [react(), ...(single ? [viteSingleFile()] : [])],
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
