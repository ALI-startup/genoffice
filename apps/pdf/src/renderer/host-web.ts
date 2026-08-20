/**
 * The browser half of the build-time host seam — the counterpart of the only file in the bundle
 * that reads a browser global.
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
} from '@samugen/platform-web'
import type { CreatePdfPlatform, PdfFilePort } from './platform'
import { createWebPdfPlatform } from './platform-web'

/** Name the browser tab after the open document. */
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
    // Handles are structured-cloneable, so IndexedDB stores the handle itself and a document
    // survives a reload without copying bytes or inventing a path.
    handles: createIndexedDbHandleStore(indexedDB, `${DOCUMENT_DB_NAME}-pdf`),
    pickers: browserFilePickers(),
  })
  const platform = createWebPdfPlatform({
    store,
    language: createWebLanguagePort(browserLanguageEnv()),
    ai: createWebAiPort(),
    // The frame link is non-null only when the web shell hosts this page in its tab strip, which it
    // signals with a query parameter.
    window: createWebWindowPort(window, createFrameChildLink()),
  })
  return { ...platform, file: titledOpen(platform.file) }
}
