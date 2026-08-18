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
  createDocsCloseSavePort,
  createDocsGensparkPort,
  createDocsLanguagePort,
  createDocsSearchPort,
  createDocsTabsPort,
  createElectronAttachmentsPort,
} from '@genoffice/platform-electron'
import type { DesktopApi, OpenResult } from '../shared/ipc'
import type {
  DocsFilePort,
  DocsHwpxPort,
  DocsPdfExportPort,
  DocsPlatform,
  DocsWindowPort,
  OpenOutcome,
} from './platform'

/** Last path segment of an absolute path, for the display name. */
const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * Bridge result → port outcome.
 *
 * A `.docx` becomes a document whose ref is its path; a `.hwpx` becomes an
 * import, which has no ref because there is nothing on disk this app can write
 * back to. The tag comes from the main process, which is the only side that saw
 * the extension.
 */
const toOpenOutcome = (result: OpenResult): OpenOutcome =>
  result.kind === 'import'
    ? {
        kind: 'import',
        imported: {
          html: result.html,
          align: result.align,
          droppedImages: result.droppedImages,
          sourceName: result.sourceName,
          name: result.name,
        },
      }
    : {
        kind: 'document',
        document: {
          ref: result.path,
          name: result.name,
          data: result.data,
          hash: result.hash,
        },
      }

/** docs' docx document surface over the Electron bridge. */
export function createDocsFilePort(bridge: DesktopApi): DocsFilePort {
  return {
    consumePending: async () => {
      const result = await bridge.consumePendingOpenDocx()
      return result ? toOpenOutcome(result) : null
    },
    consumeNewBlank: () => bridge.consumeNewBlankDoc(),
    onOpenDocument: (handler) => bridge.onOpenDocx((result) => handler(toOpenOutcome(result))),
    // The host reports two paths; the *name* is derived here rather than in the
    // renderer, which used to split newPath on path separators itself.
    onDocumentRenamed: (handler) =>
      bridge.onRenamedDocx(({ oldPath, newPath }) =>
        handler({ ref: oldPath, newRef: newPath, newName: baseName(newPath) }),
      ),
    openDocument: async () => {
      const result = await bridge.openDocx()
      return result ? toOpenOutcome(result) : null
    },
    openDocumentByRef: async (ref) => {
      const result = await bridge.openDocxPath(ref)
      return result ? toOpenOutcome(result) : null
    },
    save: (ref, data, auto) => bridge.saveDocx(ref, data, auto),
    saveAs: async (defaultName, data) => toNamedResult(await bridge.saveDocxAs(defaultName, data)),
    // `auto` is not forwarded, and that is the whole story of this host: the main
    // process writes a never-saved document into its default documents folder
    // with no dialog, so an automatic first save and a deliberate one are the same
    // silent write. The flag exists for hosts that must ask, and the desktop
    // behaviour is byte-for-byte what it was before it existed.
    saveNew: async (defaultName, data, _auto) =>
      toNamedResult(await bridge.saveDocxNew(defaultName, data)),
    writeRecoveryCopy: (ref, data) => bridge.writeRecoveryCopy(ref, data),
    // Both halves of the renderer's recovery tick land somewhere real here: the
    // main process owns a recovery directory under userData, and `saveNew` can
    // name a document without asking.
    crashRecovery: true,
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
    // Electron draws the frame and owns the application menu, so the ribbon
    // keeps its platform-specific behaviour: File in the menu bar on macOS, a
    // File tab elsewhere, and room reserved for the window controls.
    nativeChrome: true,
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
 * renders with Electron's `printToPDF` and merges fragments with pdf-lib. The web
 * host supplies `null`, and prints instead.
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
 * HWPX export over the Electron bridge.
 *
 * The conversion happens in the main process, where the file dialog and the disk
 * write already live — not because it has to: @genoffice/hwpx-convert needs no
 * filesystem, and the web adapter runs the same converter in the page.
 */
export function createDocsHwpxPort(bridge: DesktopApi): DocsHwpxPort {
  return {
    exportDocument: (defaultName, html) => bridge.exportHwpx(defaultName, html),
  }
}

/**
 * Five of the six nullable capabilities are non-null here, which is what makes
 * the desktop app's behaviour identical to before the seam existed: the shell owns
 * a tab strip, the main process owns the search client and the gsk CLI, PDF
 * export goes through `printToPDF`, and HWPX export goes through the main process.
 *
 * The sixth, `print`, is null — the one place this host declares *less* than the
 * browser one. Printing on the desktop is the native menu's, answered by
 * `webContents.print()` in the main process; no renderer code has ever started a
 * print here, `DesktopApi.print()` has no call site, and the `'print'` MenuCommand
 * reaches no case in App.tsx's switch. A port here would have to invent a second
 * print path, so the honest value is null and the desktop keeps exactly the one
 * print it had.
 */
export function createElectronDocsPlatform(bridge: DesktopApi): DocsPlatform {
  return {
    language: createDocsLanguagePort(bridge),
    ai: createDocsAiPort(bridge),
    attachments: createElectronAttachmentsPort(bridge),
    window: createDocsWindowPort(bridge),
    file: createDocsFilePort(bridge),
    tabs: createDocsTabsPort(bridge),
    search: createDocsSearchPort(bridge),
    genspark: createDocsGensparkPort(bridge),
    pdfExport: createDocsPdfExportPort(bridge),
    print: null,
    hwpx: createDocsHwpxPort(bridge),
    // Save and Save As write the real document through a native dialog and keep
    // editing it; a download would be a second, worse way to produce a copy.
    download: null,
  }
}
