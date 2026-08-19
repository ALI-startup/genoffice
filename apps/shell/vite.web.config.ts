/**
 * The web shell: the same renderer sources, no Electron, and the editors hosted
 * as same-origin frames instead of `WebContentsView` children.
 *
 * Three things make this a *web* build:
 *
 *   1. `@host` resolves to host-web.ts, so the bundle contains the router and
 *      the frame protocol and no reference to any preload global.
 *   2. The AI BFF is reachable same-origin. index.html sets `connect-src 'self'`,
 *      so the browser refuses a cross-origin AI request outright; proxying the
 *      BFF's own route prefix through this dev server is what makes the request
 *      same-origin, and it is why the browser never needs to know the BFF's
 *      address. The route prefix is declared once, in @samugen/platform-web's
 *      wire module.
 *   3. **The editors are proxied under paths of this origin**, not embedded from
 *      their own dev-server ports. That is not a convenience: a cross-origin
 *      frame would fail every AI call for the same CORS reason as above (the BFF
 *      deliberately sends no CORS headers), and its `document.title` would be
 *      unreadable, which is how the shell titles its tabs. One rule per prefix
 *      covers the app and everything it loads.
 *
 * A deployment replaces all three proxy rules with the equivalent in whatever
 * fronts the static files; the *paths* are the contract, and they are declared
 * in platform-web.ts (`WEB_APP_PATHS`) and the AI wire module.
 *
 * `npm run build:web` writes to `dist/web`, deliberately outside `out/`:
 * electron-builder.cjs packages `out/**` into every desktop installer, so a web
 * bundle there would ship inside the app. Same reasoning as apps/docs and
 * apps/pdf, which is also why the composed build (`npm run build:shell:web` at
 * the root) sends their output *into* this one, under `dist/web/app/*`.
 */
import { createRequire } from 'node:module'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { AI_BFF_BASE_PATH } from '@samugen/platform-web/wire'
import { hostAlias } from './vite.shared'

const require = createRequire(import.meta.url)
const { version } = require('./package.json') as { version: string }

/** Where `npm run start -w @samugen/ai-bff` listens by default. */
const bffTarget = process.env.AI_BFF_URL || 'http://127.0.0.1:8788'
/** Where the editors' own web dev servers listen (see their vite.web.config.ts). */
const docsTarget = process.env.DOCS_WEB_URL || 'http://127.0.0.1:5183'
const pdfTarget = process.env.PDF_WEB_URL || 'http://127.0.0.1:5186'
const slidesTarget = process.env.SLIDES_WEB_URL || 'http://127.0.0.1:5185'
const sheetsTarget = process.env.SHEETS_WEB_URL || 'http://127.0.0.1:5184'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: { alias: hostAlias('web') },
  plugins: [react()],
  define: {
    // The version the account menu shows. Electron reads it from
    // `app.getVersion()`; there is no such call in a browser, so it is baked in.
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
      // Prefix match: covers /settings, /stream, /stream/cancel and /chat. The
      // stream route is SSE and passes through unbuffered.
      [AI_BFF_BASE_PATH]: { target: bffTarget, changeOrigin: true },
      // The editors, served under this origin. `ws: true` carries their HMR
      // socket; the apps run with a matching `base`, so nothing is rewritten and
      // every asset URL they emit already carries the prefix.
      '/app/docs': { target: docsTarget, changeOrigin: true, ws: true },
      '/app/pdf': { target: pdfTarget, changeOrigin: true, ws: true },
      '/app/slides': { target: slidesTarget, changeOrigin: true, ws: true },
      '/app/sheets': { target: sheetsTarget, changeOrigin: true, ws: true },
    },
  },
})
