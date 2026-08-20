/**
 * The browser half of docs' build-time host seam — the counterpart of the only file in the bundle
 * that reads a browser global.
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
  createWebHwpConvertPort,
  createWebAiPort,
  createWebAttachmentsPort,
  createWebLanguagePort,
  DOCUMENT_FILE_TYPES,
  WebDocumentStore,
} from '@samugen/platform-web'
import { t } from './i18n/locale'
import type { CreateDocsPlatform } from './platform'
import { createWebDocsPlatform } from './platform-web'
// Print rules that only make sense for `window.print()`.
import './print-web.css'

/** Does the page currently hold transient user activation? */
function hasUserActivation(): boolean {
  const probe = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return probe === undefined || probe.isActive
}

export const createDocsPlatform: CreateDocsPlatform = async () => {
  const pickers = browserFilePickers()
  // One instance for the page: the port caches its availability probe, and that
  // answer is a property of the deployment rather than of who asked.
  const hwp = createWebHwpConvertPort()
  const store = new WebDocumentStore({
    // Handles are structured-cloneable, so IndexedDB stores the handle itself and a document
    // survives a reload without copying bytes or inventing a path.
    handles: createIndexedDbHandleStore(indexedDB, `${DOCUMENT_DB_NAME}-docs`),
    pickers,
    // Every format docs opens.
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
      // The `.hwp` converter, always wired: whether a deployment actually runs the service is not
      // knowable synchronously, and the port answers a missing one with a message naming the fix
      // (save it as .hwpx) rather than a failure.
      extractor: createBrowserAttachmentExtractor({ hwp }),
    }),
    hasUserActivation,
    // The browser's own dialog, standing in for the native warning box the Electron main process
    // shows on the same condition.
    confirmOverwrite: () => window.confirm(t('appSaveExtModified')),
    // The browser's downloads, which is where a document with no file handle goes when the user
    // asks for it — a new document, or one imported from `.hwpx`.
    deliverDownload: (fileName, data, mimeType) =>
      downloadBytes(browserDownloadEnv(), fileName, data, mimeType),
    // Opening a `.hwp` goes through the same service the attachment path uses.
    hwp,
    // Non-null only when the web shell hosts this page in its tab strip, which it signals with a
    // query parameter.
    frame: createFrameChildLink(),
  })
}
