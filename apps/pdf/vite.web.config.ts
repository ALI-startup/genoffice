/**
 * The browser build: same renderer sources, no Electron.
 *
 * Two things make it a *web* build rather than a differently-flagged Electron
 * one:
 *
 *   1. `@host` resolves to host-web.ts, so the bundle contains the File System
 *      Access document store and no reference to `window.pdfApi`.
 *   2. The AI BFF is reachable same-origin. index.html sets
 *      `connect-src 'self'`, so the browser refuses a cross-origin AI request
 *      outright; proxying the BFF's own route prefix through this dev server is
 *      what makes the request same-origin, and it is also why the browser never
 *      needs to know the BFF's address. A deployment replaces this proxy with
 *      the equivalent rule in whatever fronts the static files — the route
 *      prefix is the contract, and it is declared once, in
 *      @genoffice/platform-web's wire module.
 */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { AI_BFF_BASE_PATH } from '@genoffice/platform-web/wire'
import { hostAlias, pdfjsCopyTargets } from './vite.shared'

/** Where `npm run start -w @genoffice/ai-bff` listens by default. */
const bffTarget = process.env.AI_BFF_URL || 'http://127.0.0.1:8788'

export default defineConfig({
  root: 'src/renderer',
  // Standalone this app owns its origin, so a relative base is right. The web
  // shell serves it under a path of *its* origin instead (`/app/pdf/`), which is
  // what keeps this app's AI calls same-origin and its title readable from the
  // tab strip — so the shell's dev script and its composed build set the base to
  // that prefix. Nothing else about the build differs.
  base: process.env.PDF_WEB_BASE || './',
  resolve: { alias: hostAlias('web') },
  plugins: [react(), viteStaticCopy({ targets: pdfjsCopyTargets() })],
  build: {
    // Deliberately outside `out/`: apps/shell/electron-builder.cjs ships
    // `from: '../pdf/out'` as an extraResource, so a web bundle under out/
    // would be packaged into every desktop installer as dead weight. The shell's
    // composed web build redirects it under the shell's own dist/web instead.
    outDir: process.env.PDF_WEB_OUT_DIR || '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.PDF_WEB_PORT) || 5186,
    strictPort: true,
    proxy: {
      // Prefix match: this covers /settings, /stream, /stream/cancel and /chat.
      // The stream route is SSE and passes through unbuffered — http-proxy pipes
      // the response, and the BFF sends `x-accel-buffering: no` for whatever
      // else sits in front of it in a real deployment.
      [AI_BFF_BASE_PATH]: { target: bffTarget, changeOrigin: true },
    },
  },
})
