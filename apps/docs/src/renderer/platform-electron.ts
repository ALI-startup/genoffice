/**
 * Builds docs' platform from the Electron preload bridge (`window.desktop`).
 *
 * The shared ports come from @genoffice/platform-electron; docs' own surfaces —
 * the docx document operations, the close-check handshake, the native-menu and
 * teardown channels, and PDF export — are adapted here, next to the port
 * declarations they satisfy. Nothing in this file talks to Electron directly: the
 * bridge is passed in, so the global is read exactly once, in host-electron.ts.
 *
 * Electron's `DocumentRef` *is* the absolute path, so most of the mapping is a
 * rename. This adapter is the only place allowed to read a ref as a path — that
 * is what makes it the Electron adapter — which is also where every display name
 * comes from, since the renderer must not parse a ref itself.
 */
import {
  createDocsAiPort,
  createDocsAttachmentsPort,
  createDocsCloseSavePort,
  createDocsGensparkPort,
  createDocsLanguagePort,
  createDocsSearchPort,
  createDocsTabsPort,
} from '@genoffice/platform-electron'
import type { DesktopApi, OpenFileResult } from '../shared/ipc'
import type {
  DocsFilePort,
  DocsPdfExportPort,
  DocsPlatform,
  DocsWindowPort,
  OpenedDocument,
} from './platform'

/** Last path segment of an absolute path, for the display name. */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Bridge result → port document: the path becomes the ref, the name comes along unchanged. */
const toOpenedDocument = (result: OpenFileResult): OpenedDocument => ({
  ref: result.path,
  name: result.name,
  data: result.data,
  hash: result.hash,
})

/** docs' docx document surface over the Electron bridge. */
export function createDocsFilePort(bridge: DesktopApi): DocsFilePort {
  return {
    consumePending: async () => {
      const result = await bridge.consumePendingOpenDocx()
      return result ? toOpenedDocument(result) : null
    },
    consumeNewBlank: () => bridge.consumeNewBlankDoc(),
    onOpenDocument: (handler) => bridge.onOpenDocx((result) => handler(toOpenedDocument(result))),
    // The host reports two paths; the *name* is derived here rather than in the
    // renderer, which used to split newPath on path separators itself.
    onDocumentRenamed: (handler) =>
      bridge.onRenamedDocx(({ oldPath, newPath }) =>
        handler({ ref: oldPath, newRef: newPath, newName: baseName(newPath) }),
      ),
    openDocument: async () => {
      const result = await bridge.openDocx()
      return result ? toOpenedDocument(result) : null
    },
    openDocumentByRef: async (ref) => {
      const result = await bridge.openDocxPath(ref)
      return result ? toOpenedDocument(result) : null
    },
    save: (ref, data, auto) => bridge.saveDocx(ref, data, auto),
    saveAs: async (defaultName, data) => toNamedResult(await bridge.saveDocxAs(defaultName, data)),
    saveNew: async (defaultName, data) =>
      toNamedResult(await bridge.saveDocxNew(defaultName, data)),
    writeRecoveryCopy: (ref, data) => bridge.writeRecoveryCopy(ref, data),
    // `location` is the absolute path: this host has one, so a recent entry can
    // still show it. `name` is what any list would render.
    recentDocuments: async () =>
      (await bridge.getRecentFiles()).map((path) => ({
        ref: path,
        name: baseName(path),
        location: path,
      })),
    pickImage: () => bridge.pickImage(),
  }
}

/** A save-with-a-name result: the destination path is the ref, and it names the document. */
function toNamedResult(result: { ok: boolean; path?: string; error?: string }): {
  ok: boolean
  ref?: string
  name?: string
  error?: string
} {
  return {
    ok: result.ok,
    ...(result.path === undefined ? {} : { ref: result.path, name: baseName(result.path) }),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

/** docs' window integration: the shared close-guard reply slice plus the four docs-only channels. */
export function createDocsWindowPort(bridge: DesktopApi): DocsWindowPort {
  return {
    ...createDocsCloseSavePort(bridge),
    onCloseCheck: (handler) => bridge.onCloseCheck(handler),
    // The ref→filePath rename lives here. The main process resolves it to clean
    // up the recovery copy on "Don't Save"; nothing on that side changes.
    reportCloseCheck: ({ dirty, autoSave, ref }) =>
      bridge.reportCloseCheck({ dirty, autoSave, filePath: ref }),
    onTeardown: (handler) => bridge.onTeardown(handler),
    onMenuCommand: (handler) => bridge.onMenuCommand(handler),
  }
}

/**
 * PDF export over the Electron bridge.
 *
 * Non-null because this host really does have a PDF pipeline: the main process
 * renders with Electron's `printToPDF` and merges fragments with pdf-lib. A web
 * host will supply `null` here until it has a renderer-side exporter.
 */
export function createDocsPdfExportPort(bridge: DesktopApi): DocsPdfExportPort {
  return {
    exportPdf: (defaultName, pageWidthTwips, pageHeightTwips, outPath) =>
      bridge.exportPdf(defaultName, pageWidthTwips, pageHeightTwips, outPath),
    printPdfBuffer: (pageWidthTwips, pageHeightTwips) =>
      bridge.printPdfBuffer(pageWidthTwips, pageHeightTwips),
    saveMergedPdf: (defaultName, base64Parts, outPath) =>
      bridge.saveMergedPdf(defaultName, base64Parts, outPath),
  }
}

/**
 * Every one of the four nullable capabilities is non-null here, which is what
 * makes the desktop app's behaviour identical to before the seam existed: the
 * shell owns a tab strip, the main process owns the search client and the gsk
 * CLI, and PDF export goes through `printToPDF`.
 */
export function createElectronDocsPlatform(bridge: DesktopApi): DocsPlatform {
  return {
    language: createDocsLanguagePort(bridge),
    ai: createDocsAiPort(bridge),
    attachments: createDocsAttachmentsPort(bridge),
    window: createDocsWindowPort(bridge),
    file: createDocsFilePort(bridge),
    tabs: createDocsTabsPort(bridge),
    search: createDocsSearchPort(bridge),
    genspark: createDocsGensparkPort(bridge),
    pdfExport: createDocsPdfExportPort(bridge),
  }
}
