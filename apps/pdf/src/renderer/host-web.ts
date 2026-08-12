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
 * same-origin is also why the browser never needs a credential here.
 */
import {
  browserFilePickers,
  browserLanguageEnv,
  createFrameChildLink,
  createIndexedDbHandleStore,
  DOCUMENT_DB_NAME,
  createWebAiPort,
  createWebLanguagePort,
  createWebWindowPort,
  WebDocumentStore,
} from '@genoffice/platform-web'
import type { CreatePdfPlatform, PdfFilePort } from './platform'
import { createWebPdfPlatform } from './platform-web'

/**
 * Name the browser tab after the open document.
 *
 * The one document-level singleton this host writes, and it is written here
 * rather than in platform-web.ts because that module deliberately touches no
 * globals. Under Electron the equivalent is the shell's tab manager, which
 * derives a tab title from the path it opened the view with; a browser handle
 * has no path, so the name comes from the picker and lands on `document.title`.
 * That is also what the web shell reads to title its tab, since a same-origin
 * frame's title is readable and needs no protocol.
 */
function titledOpen(file: PdfFilePort): PdfFilePort {
  const openDocument = file.openDocument
  if (openDocument === null) return file
  return {
    ...file,
    openDocument: async () => {
      const opened = await openDocument()
      if (opened !== null) document.title = opened.name
      return opened
    },
  }
}

export const createPdfPlatform: CreatePdfPlatform = async () => {
  const store = new WebDocumentStore({
    // Handles are structured-cloneable, so IndexedDB stores the handle itself
    // and a document survives a reload without copying bytes or inventing a path.
    // The database name is per-app on purpose: the store's list() is an
    // unfiltered getAll(), so a shared database would put this app's documents
    // in another app's recent list when both run on the same origin — which is
    // exactly the arrangement inside the web shell, where every editor is a
    // frame of one origin.
    handles: createIndexedDbHandleStore(indexedDB, `${DOCUMENT_DB_NAME}-pdf`),
    pickers: browserFilePickers(),
  })
  const platform = createWebPdfPlatform({
    store,
    language: createWebLanguagePort(browserLanguageEnv()),
    ai: createWebAiPort(),
    // The frame link is non-null only when the web shell hosts this page in its
    // tab strip, which it signals with a query parameter. It is what lets the
    // shell's close guard ask this document whether it has unsaved work, and ask
    // it to save: closing a shell tab removes the iframe, and `beforeunload`
    // does not fire for that. Standalone there is no shell, so it is null and
    // nothing about the page changes.
    window: createWebWindowPort(window, createFrameChildLink()),
  })
  return { ...platform, file: titledOpen(platform.file) }
}
