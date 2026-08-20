/** The browser build: same renderer sources, no Electron. */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { AI_BFF_BASE_PATH } from '@samugen/platform-web/wire'
import { CONVERT_BASE_PATH } from '@samugen/platform-web/convert-wire'
import { hostAlias } from './vite.shared'

/** Where `npm run start -w @samugen/ai-bff` listens by default. */
const bffTarget = process.env.AI_BFF_URL || 'http://127.0.0.1:8788'
/** The `.hwp` converter; unset means nothing is running and `.hwp` reports so. */
const convertTarget = process.env.HWP_CONVERT_URL || 'http://127.0.0.1:8789'

export default defineConfig({
  root: 'src/renderer',
  // Standalone this app owns its origin, so a relative base is right.
  base: process.env.SHEETS_WEB_BASE || './',
  resolve: { alias: hostAlias() },
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
      // One document up, one back — no streaming, so nothing to unbuffer.
      [CONVERT_BASE_PATH]: { target: convertTarget, changeOrigin: true },
    },
  },
})
