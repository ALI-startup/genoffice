/**
 * Electron implementations of the @genoffice/platform ports.
 *
 * This package runs in the **renderer**, not the main process: it adapts the
 * globals a preload has already exposed (`window.pdfApi`, `window.desktop`,
 * `window.projectApi`) onto the capability ports. It therefore must never
 * import `electron` — the ipcRenderer plumbing stays in each app's preload,
 * unchanged, and this layer only renames and re-groups what is already there.
 *
 * Every factory takes its bridge as an argument rather than reading the global,
 * which keeps the adapters unit-testable and the coupling to `window` explicit
 * and confined to each renderer's bootstrap.
 *
 * Scope: pdf (Phase 2) and docs (Phase 4a). slides / sheets adapters land with
 * their own migrations, so that each one is written against real call sites
 * rather than guessed at.
 *
 * Only the *shared* ports live here. Each app's own surfaces stay in the app,
 * next to the port declarations they satisfy — pdf's document operations and
 * Save As handshake in apps/pdf/src/renderer/platform-electron.ts, docs' docx
 * document surface, close-check handshake, native-menu channel and PDF export in
 * apps/docs/src/renderer/platform-electron.ts.
 */
export type {
  DocsAiBridge,
  DocsAttachmentAddResultBridge,
  DocsAttachmentMetaBridge,
  DocsAttachmentsBridge,
  DocsCloseSaveBridge,
  DocsCloseSaveSlice,
  DocsGensparkBridge,
  DocsLanguageBridge,
  DocsSearchBridge,
  DocsTabsBridge,
  DocsTabsSlice,
} from './docs.js'
export {
  createDocsAiPort,
  createDocsAttachmentsPort,
  createDocsCloseSavePort,
  createDocsGensparkPort,
  createDocsLanguagePort,
  createDocsSearchPort,
  createDocsTabsPort,
} from './docs.js'
export type { PdfAiBridge, PdfLanguageBridge, PdfWindowBridge, PdfWindowSlice } from './pdf.js'
export { createPdfAiPort, createPdfLanguagePort, createPdfWindowPort } from './pdf.js'
