/** The browser build: same renderer sources, no Electron. */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { AI_BFF_BASE_PATH } from '@samugen/platform-web/wire'
import { CONVERT_BASE_PATH } from '@samugen/platform-web/convert-wire'
import { hostAlias, pdfjsCopyTargets } from './vite.shared'

/** Where `npm run start -w @samugen/ai-bff` listens by default. */
const bffTarget = process.env.AI_BFF_URL || 'http://127.0.0.1:8788'
/** The `.hwp` converter; unset means nothing is running and `.hwp` reports so. */
const convertTarget = process.env.HWP_CONVERT_URL || 'http://127.0.0.1:8789'

export default defineConfig({
  root: 'src/renderer',
  // Standalone this app owns its origin, so a relative base is right.
  base: process.env.PDF_WEB_BASE || './',
  resolve: { alias: hostAlias() },
  plugins: [react(), viteStaticCopy({ targets: pdfjsCopyTargets() })],
  build: {
    // Deliberately outside `out/`: apps/shell/electron-builder.cjs ships `from: '../pdf/out'` as an
    // extraResource, so a web bundle under out/ would be packaged into every desktop installer as
    // dead weight.
    outDir: process.env.PDF_WEB_OUT_DIR || '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.PDF_WEB_PORT) || 5186,
    strictPort: true,
    proxy: {
      // Prefix match: this covers /settings, /stream, /stream/cancel and /chat.
      [AI_BFF_BASE_PATH]: { target: bffTarget, changeOrigin: true },
      // One document up, one back — no streaming, so nothing to unbuffer.
      [CONVERT_BASE_PATH]: { target: convertTarget, changeOrigin: true },
    },
  },
})
