/**
 * The browser half of docs' build-time host seam — the counterpart of
 * the only file in the bundle that reads a browser global.
 *
 * `vite.web.config.ts` aliases `@host` here, so nothing in this file (nor
 * anything it imports) reaches the Electron bundle, and `window.desktop` is never
 * referenced: there is no preload bridge to shim, which is the point of deleting
 * the old web-shim.js.
 *
 * The AI port takes no configuration. It calls the BFF's routes on this origin,
 * which the dev server proxies — see `vite.web.config.ts`. That indirection is
 * required, not cosmetic: the renderer's CSP is `connect-src 'self'`, so a
 * cross-origin BFF URL would be blocked by the browser, and keeping it
 * same-origin is also what stops any credential from being needed here.
 *
 * Which attachment parsers the web bundle carries is also chosen here — by picking
 * @samugen/platform-web's default extractor, which is where the honest limits of
 * client-side extraction are recorded. It moved there when slides needed the same
 * set; passing it in is still the app's decision.
 */
import {
  browserDownloadEnv,
  browserFilePickers,
  browserLanguageEnv,
  browserMultiFilePicker,
  downloadBytes,
  createFrameChildLink,
  createIndexedDbHandleStore,
  DOCUMENT_DB_NAME,
  createBrowserAttachmentExtractor,
  createWebAiPort,
  createWebAttachmentsPort,
  createWebLanguagePort,
  DOCUMENT_FILE_TYPES,
  WebDocumentStore,
} from '@samugen/platform-web'
import { t } from './i18n/locale'
import type { CreateDocsPlatform } from './platform'
import { createWebDocsPlatform } from './platform-web'
// Print rules that only make sense for `window.print()`. Imported here rather
// than from main.tsx so they follow the `@host` alias into the web bundle alone
// and cannot reach the print CSS Electron's printToPDF renders through.
import './print-web.css'

/**
 * Does the page currently hold transient user activation?
 *
 * `showSaveFilePicker` requires it, and this is the only way to ask before
 * calling. A browser without `navigator.userActivation` (the API is newer than
 * the pickers) answers `true`, so the picker itself makes the decision and
 * rejects — the same outcome, one dialog later, and never a silently skipped save.
 */
function hasUserActivation(): boolean {
  const probe = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return probe === undefined || probe.isActive
}

export const createDocsPlatform: CreateDocsPlatform = async () => {
  const pickers = browserFilePickers()
  const store = new WebDocumentStore({
    // Handles are structured-cloneable, so IndexedDB stores the handle itself
    // and a document survives a reload without copying bytes or inventing a path.
    // The database name is per-app on purpose: the store's list() is an
    // unfiltered getAll(), so a shared database would put this app's documents
    // in another app's recent list when both run on the same origin.
    handles: createIndexedDbHandleStore(indexedDB, `${DOCUMENT_DB_NAME}-docs`),
    pickers,
    // Both formats docs opens. A .hwpx is converted on the way in and becomes
    // an unsaved .docx, so the store never saves back to one — see the import
    // branch in platform-web.ts.
    fileTypes: DOCUMENT_FILE_TYPES,
    pickerId: 'samugen-docx',
  })
  return createWebDocsPlatform({
    store,
    pickers,
    language: createWebLanguagePort(browserLanguageEnv()),
    ai: createWebAiPort(),
    attachments: createWebAttachmentsPort({
      pick: browserMultiFilePicker(),
      extractor: createBrowserAttachmentExtractor(),
    }),
    hasUserActivation,
    // The browser's own dialog, standing in for the native warning box the
    // Electron main process shows on the same condition. `window.confirm` is
    // synchronous and blocking, which is what the save path needs: the answer has
    // to be in hand before anything is written. Wording comes from the renderer's
    // i18n, so it is localised in all the languages the desktop prompt is.
    confirmOverwrite: () => window.confirm(t('appSaveExtModified')),
    // The browser's downloads, which is where a document with no file handle goes
    // when the user asks for it — a new document, or one imported from `.hwpx`.
    // Passed as a function so platform-web.ts keeps its promise of touching no
    // globals; the DOM work is in @samugen/platform-web's download.ts.
    deliverDownload: (fileName, data, mimeType) =>
      downloadBytes(browserDownloadEnv(), fileName, data, mimeType),
    // Non-null only when the web shell hosts this page in its tab strip, which
    // it signals with a query parameter. It is what lets the shell's close guard
    // ask this document whether it has unsaved work, and ask it to save: closing
    // a shell tab removes the iframe, and `beforeunload` does not fire for that.
    // Standalone in a browser tab there is no shell, so this is null and nothing
    // about the page changes.
    frame: createFrameChildLink(),
  })
}
