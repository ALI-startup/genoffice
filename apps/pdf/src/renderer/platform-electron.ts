/**
 * Builds pdf's platform from the Electron preload bridge (`window.pdfApi`).
 *
 * The shared ports come from @genoffice/platform-electron; the two app-specific
 * surfaces — the document operations and the Save As handshake — are adapted
 * here, next to the port declarations they satisfy. Nothing in this file talks
 * to Electron directly: the bridge is passed in, so the global is read exactly
 * once, in host-electron.ts — the module the Electron Vite configs alias `@host`
 * to, and the only Electron-specific file either web bundle never sees.
 */
import {
  createPdfAiPort,
  createPdfLanguagePort,
  createPdfWindowPort,
} from '@genoffice/platform-electron'
import type { PdfApi } from '../shared/ipc'
import type { PdfFilePort, PdfPlatform } from './platform'

/** Last path segment of an absolute path, for the display name (was App.tsx's `fileName`). */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/**
 * pdf's document surface.
 *
 * Electron's DocumentRef *is* the absolute path, so the mapping is a rename
 * (`ref` → the channels' `path`) and nothing on the main-process side changes.
 * This adapter is the only place allowed to read the ref as a path — that is
 * what makes it the Electron adapter — which is also where the display name
 * and location come from, since the renderer must not parse the ref itself.
 */
export function createPdfFilePort(bridge: PdfApi): PdfFilePort {
  return {
    // Null, not a stub: pdf's preload exposes no open channel and its main
    // process registers no handler for one — the shell opens files and queues
    // them as pending documents. So the renderer must not offer an Open button
    // under Electron, and this is what tells it so.
    openDocument: null,
    consumePending: async () => {
      const path = await bridge.consumePending()
      // `location` is the absolute path: this host has one, so the file-name
      // tooltip keeps showing it exactly as it always has.
      return path ? { ref: path, name: baseName(path), location: path } : null
    },
    readFile: (ref) => bridge.readFile(ref),
    save: ({ ref, target, ...edits }) =>
      bridge.save({
        path: ref,
        ...(target === undefined ? {} : { targetPath: target }),
        ...edits,
      }),
    extractPages: ({ ref, ...rest }) => bridge.extractPages({ path: ref, ...rest }),
    insertPdf: ({ ref, ...rest }) => bridge.insertPdf({ path: ref, ...rest }),
    exportImages: (request) => bridge.exportImages(request),
  }
}

export function createElectronPdfPlatform(bridge: PdfApi): PdfPlatform {
  return {
    language: createPdfLanguagePort(bridge),
    ai: createPdfAiPort(bridge),
    window: {
      ...createPdfWindowPort(bridge),
      onSaveAsRequest: (handler) => bridge.onSaveAsRequest(handler),
      // Rename, as with reportCloseSaveResult: the bridge says `send`.
      reportSaveAsResult: (ok) => bridge.sendSaveAsResult(ok),
      onSaveAsFlow: (handler) => bridge.onSaveAsFlow(handler),
    },
    file: createPdfFilePort(bridge),
  }
}
