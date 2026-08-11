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
 * Scope: pdf only for now (Phase 2). docs / slides / sheets adapters land with
 * their own migrations, so that each one is written against real call sites
 * rather than guessed at.
 */
export type { PdfAiBridge, PdfLanguageBridge, PdfWindowBridge, PdfWindowSlice } from './pdf.js'
export { createPdfAiPort, createPdfLanguagePort, createPdfWindowPort } from './pdf.js'
