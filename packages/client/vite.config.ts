import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Workspace packages resolve to source, not to a build step. The archetype
 * generator is iterated against the preview harness (§16.1) and a compile
 * between every tweak is exactly the slow, miserable loop the harness exists
 * to avoid.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@civ/core': resolve(__dirname, '../core/src/index.ts'),
      '@civ/sim': resolve(__dirname, '../sim/src/index.ts'),
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview/index.html'),
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
})
