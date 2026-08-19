/**
 * The browser build: same renderer sources, no Electron.
 *
 * Three things make it a *web* build rather than a differently-flagged Electron one:
 *
 *   1. `@host` resolves to host-web.ts, so the bundle carries the File System Access file
 *      port, the wasm engine and its Worker, and no reference to `window.desktopApi`.
 *   2. The AI BFF is reachable same-origin. index.html sets `connect-src 'self'`, so the
 *      browser refuses a cross-origin AI request outright; proxying the BFF's own route
 *      prefix through this dev server is what makes the request same-origin, and it is also
 *      why the browser never needs to know the BFF's address.
 *   3. The engine is an asset, not a module. `?url` keeps the 4.5MB `.wasm` out of the
 *      JavaScript bundle so it is fetched only when a workbook is opened, and `?worker` gives
 *      the Worker its own chunk.
 */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { AI_BFF_BASE_PATH } from '@genoffice/platform-web/wire'
import { hostAlias } from './vite.shared'

/** Where `npm run start -w @genoffice/ai-bff` listens by default. */
const bffTarget = process.env.AI_BFF_URL || 'http://127.0.0.1:8788'

export default defineConfig({
  root: 'src/renderer',
  // Standalone this app owns its origin, so a relative base is right. The web shell serves it
  // under a path of *its* origin instead (`/app/sheets/`), which is what keeps this app's AI
  // calls same-origin and its title readable from the tab strip.
  base: process.env.SHEETS_WEB_BASE || './',
  resolve: { alias: hostAlias('web') },
  plugins: [react()],
  build: {
    // Deliberately outside `out/`: apps/shell/electron-builder.cjs ships `from:
    // '../sheets/out'` as an extraResource, so a web bundle under out/ would be packaged into
    // every desktop installer as dead weight.
    outDir: process.env.SHEETS_WEB_OUT_DIR || '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.SHEETS_WEB_PORT) || 5184,
    strictPort: true,
    proxy: {
      // Prefix match: this covers /settings, /stream, /stream/cancel and /chat.
      [AI_BFF_BASE_PATH]: { target: bffTarget, changeOrigin: true },
    },
  },
})
