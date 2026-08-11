/**
 * The browser half of docs' build-time host seam — the counterpart of
 * host-electron.ts, and the only file in the web bundle that reads a global.
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
 * This file also chooses which attachment parsers the web bundle carries — see
 * `browserAttachmentExtractor`, which is where the honest limits of client-side
 * extraction are recorded.
 */
import {
  browserFilePickers,
  browserLanguageEnv,
  browserMultiFilePicker,
  createIndexedDbHandleStore,
  createWebAiPort,
  createWebAttachmentsPort,
  createWebLanguagePort,
  ATTACHMENT_TEXT_EXTS,
  DOCX_FILE_TYPES,
  WebDocumentStore,
  type WebAttachmentExtractor,
  type WebAttachmentSource,
  type WebAttachmentText,
} from '@genoffice/platform-web'
import { t } from './i18n/locale'
import type { CreateDocsPlatform } from './platform'
import { createWebDocsPlatform } from './platform-web'

/**
 * Formats a browser can extract text from, beyond plain text.
 *
 * These three go through @genoffice/file-parse's browser entry point — the same
 * extractors the Electron main process runs, byte-for-byte, because they only
 * ever needed bytes and jszip / fast-xml-parser run in a browser unchanged. The
 * parsers are loaded on first use so a session that attaches nothing never pays
 * for them.
 */
const OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx'])

/**
 * Formats the Electron host accepts and this one does not, with the reason.
 *
 * They are listed rather than silently missing so `addAttachments` can reject
 * them with something the user can act on, instead of accepting the file and
 * failing later when the model asks to read it.
 *
 *   - `pdf` — @genoffice/file-parse's PDF extractor is Node-only: it locates
 *     pdfjs's standard-fonts directory with `createRequire` and imports pdfjs's
 *     Node legacy build, which a browser bundle cannot even build against. PDF
 *     text extraction *is* possible in a browser (pdfjs ships a web build), but it
 *     is a rewrite of that module rather than a reuse of it, so it is out of this
 *     phase.
 *   - `ppt` / `xls` — the legacy binary Office formats. Nothing in the codebase
 *     parses them on any host: Electron accepts them at add time and then fails at
 *     read time, because `parseFileToText` has no case for them. Rejecting them up
 *     front is the same capability, reported earlier.
 */
const UNSUPPORTED_EXTS: Record<string, string> = {
  pdf: 'PDF text extraction is not available in the browser build',
  ppt: 'legacy .ppt is not supported; save it as .pptx',
  xls: 'legacy .xls is not supported; save it as .xlsx',
}

/** UTF-8, and strict: a mis-decoded attachment would feed the model plausible nonsense. */
const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)

export function browserAttachmentExtractor(): WebAttachmentExtractor {
  return {
    supports: (ext) => ATTACHMENT_TEXT_EXTS.has(ext) || OFFICE_EXTS.has(ext),
    async extract(file: WebAttachmentSource): Promise<WebAttachmentText> {
      const reason = UNSUPPORTED_EXTS[file.ext]
      if (reason) return { ok: false, error: `${file.name}: ${reason}` }
      try {
        const bytes = await file.bytes()
        if (ATTACHMENT_TEXT_EXTS.has(file.ext)) return { ok: true, text: decodeUtf8(bytes) }
        const { docxToText, pptxToText, xlsxToText } = await import('@genoffice/file-parse/browser')
        switch (file.ext) {
          case 'docx':
            return { ok: true, text: await docxToText(bytes) }
          case 'pptx':
            return { ok: true, text: await pptxToText(bytes) }
          case 'xlsx':
            return { ok: true, text: await xlsxToText(bytes) }
        }
        return { ok: false, error: `${file.name}: unsupported file type (.${file.ext})` }
      } catch (error) {
        return {
          ok: false,
          error: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}

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
    handles: createIndexedDbHandleStore(),
    pickers,
    fileTypes: DOCX_FILE_TYPES,
    pickerId: 'genoffice-docx',
  })
  return createWebDocsPlatform({
    store,
    pickers,
    language: createWebLanguagePort(browserLanguageEnv()),
    ai: createWebAiPort(),
    attachments: createWebAttachmentsPort({
      pick: browserMultiFilePicker(),
      extractor: browserAttachmentExtractor(),
    }),
    hasUserActivation,
    // The browser's own dialog, standing in for the native warning box the
    // Electron main process shows on the same condition. `window.confirm` is
    // synchronous and blocking, which is what the save path needs: the answer has
    // to be in hand before anything is written. Wording comes from the renderer's
    // i18n, so it is localised in all the languages the desktop prompt is.
    confirmOverwrite: () => window.confirm(t('appSaveExtModified')),
  })
}
