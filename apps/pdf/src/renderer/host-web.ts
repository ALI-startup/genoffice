/**
 * The browser half of the build-time host seam — the counterpart of
 * host-electron.ts, and the only file in the web bundle that reads a global.
 *
 * `vite.web.config.ts` aliases `@host` here, so nothing in this file (nor
 * anything it imports) reaches the Electron bundle, and `window.pdfApi` is never
 * referenced: there is no preload bridge to shim, which is the point of deleting
 * the old web-shim.js.
 *
 * The AI port takes no configuration. It calls the BFF's routes on this origin,
 * which the dev server proxies — see `vite.web.config.ts`. That indirection is
 * required, not cosmetic: the renderer's CSP is `connect-src 'self'`, so a
 * cross-origin BFF URL would be blocked by the browser, and keeping it
 * same-origin is also what stops any credential from being needed here.
 */
import {
  browserFilePickers,
  browserLanguageEnv,
  createIndexedDbHandleStore,
  createWebAiPort,
  createWebLanguagePort,
  createWebWindowPort,
  WebDocumentStore,
} from '@genoffice/platform-web'
import type { CreatePdfPlatform } from './platform'
import { createWebPdfPlatform } from './platform-web'

export const createPdfPlatform: CreatePdfPlatform = async () => {
  const store = new WebDocumentStore({
    // Handles are structured-cloneable, so IndexedDB stores the handle itself
    // and a document survives a reload without copying bytes or inventing a path.
    handles: createIndexedDbHandleStore(),
    pickers: browserFilePickers(),
  })
  return createWebPdfPlatform({
    store,
    language: createWebLanguagePort(browserLanguageEnv()),
    ai: createWebAiPort(),
    window: createWebWindowPort(),
  })
}
