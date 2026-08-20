/**
 * The web shell: the same renderer sources, no Electron, and the editors hosted as same-origin
 * frames instead of `WebContentsView` children.
 */
import { createRequire } from 'node:module'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { AI_BFF_BASE_PATH } from '@samugen/platform-web/wire'
import { CONVERT_BASE_PATH } from '@samugen/platform-web/convert-wire'
import { hostAlias } from './vite.shared'

const require = createRequire(import.meta.url)
const { version } = require('./package.json') as { version: string }

/** Where `npm run start -w @samugen/ai-bff` listens by default. */
const bffTarget = process.env.AI_BFF_URL || 'http://127.0.0.1:8788'
/** The `.hwp` converter; unset means nothing is running and `.hwp` reports so. */
const convertTarget = process.env.HWP_CONVERT_URL || 'http://127.0.0.1:8789'
/** Where the editors' own web dev servers listen (see their vite.web.config.ts). */
const docsTarget = process.env.DOCS_WEB_URL || 'http://127.0.0.1:5183'
const pdfTarget = process.env.PDF_WEB_URL || 'http://127.0.0.1:5186'
const slidesTarget = process.env.SLIDES_WEB_URL || 'http://127.0.0.1:5185'
const sheetsTarget = process.env.SHEETS_WEB_URL || 'http://127.0.0.1:5184'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: { alias: hostAlias() },
  plugins: [react()],
  define: {
    // The version the account menu shows.
    __SHELL_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.SHELL_WEB_PORT) || 5190,
    strictPort: true,
    proxy: {
      // Prefix match: covers /settings, /stream, /stream/cancel and /chat.
      [AI_BFF_BASE_PATH]: { target: bffTarget, changeOrigin: true },
      // One document up, one back — no streaming, so nothing to unbuffer.
      [CONVERT_BASE_PATH]: { target: convertTarget, changeOrigin: true },
      // The editors, served under this origin.
      '/app/docs': { target: docsTarget, changeOrigin: true, ws: true },
      '/app/pdf': { target: pdfTarget, changeOrigin: true, ws: true },
      '/app/slides': { target: slidesTarget, changeOrigin: true, ws: true },
      '/app/sheets': { target: sheetsTarget, changeOrigin: true, ws: true },
    },
  },
})
