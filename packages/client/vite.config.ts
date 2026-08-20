import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Workspace packages resolve to source, not to a build step. The archetype
 * generator is iterated against the preview harness (§16.1) and a compile
 * between every tweak is exactly the slow, miserable loop the harness exists
 * to avoid.
 *
 * §21.6: `@civ/sim` is deliberately absent. The client is a pure observer, and
 * the surest way to keep it one is for the simulation to be unreachable from
 * here — not a rule anyone has to remember, a missing edge in the graph. It is
 * also what makes the Vercel bundle small: the sim never ships to a browser.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@civ/core': resolve(__dirname, '../core/src/index.ts'),
      '@civ/protocol': resolve(__dirname, '../protocol/src/index.ts'),
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        /**
         * §79: the desk is the homepage and the viewer moved to /w/.
         *
         * The viewer keeps reading `?chunk=`, so every harness and existing
         * link only gains the `/w/` prefix rather than changing shape. A
         * `/w/<slug>` path is rewritten to this entry by vercel.json, and the
         * viewer reads the slug from the path when the query is absent.
         */
        desk: resolve(__dirname, 'index.html'),
        main: resolve(__dirname, 'w/index.html'),
        og: resolve(__dirname, 'og.html'),
        preview: resolve(__dirname, 'preview/index.html'),
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
})
