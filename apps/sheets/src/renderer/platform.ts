/**
 * sheets' host seam: the capabilities the renderer needs, grouped by what a host must
 * actually be able to do, and the slot that holds one host's answer.
 *
 * The renderer used to reach `window.desktopApi` directly at 45 sites across ten files —
 * sometimes as `window.desktopApi.x()`, sometimes as `window.desktopApi?.x?.()`, which is
 * the shape that hides a missing capability instead of naming it. Every one of those now
 * goes through a port, and the optional chaining is gone: a member is either present on
 * every host or it lives on a nullable port the caller has to test.
 *
 * The split is the design. Six ports are required and a web host must answer all of them;
 * five are `X | null`, and each of those is a capability a browser genuinely cannot back:
 *
 *   - `menu` — the native application menu's File commands. A page has no menu bar; the
 *     same commands are on the app's own toolbar, which is where a browser user finds them.
 *   - `pdfExport` — Electron prints the workbook to PDF through a hidden window. A page can
 *     print, but that is a different operation with a different result, and offering it
 *     under the same name would misreport what happened (docs reached this conclusion
 *     first).
 *   - `genspark` — sign-in shells out to the `gsk` CLI.
 *   - `search` — the main process's Serper/DuckDuckGo client, holding its own credential.
 *     There is no BFF route for it yet, so a browser host has nothing to call.
 *   - `project` — the chat/project history store, a main-process database (§6.1).
 *
 * `workbook` is the port Phase 6b replaces wholesale: every member of it is answered today
 * by the Rust sidecar over stdio, and by the same crate compiled to WASM in a browser. That
 * it is one port with five members, rather than five members scattered across the seam, is
 * what makes that swap a change of host rather than a change of renderer.
 */
import { createPlatformSlot, type AttachmentsPort } from '@genoffice/platform'
import type { ProjectApi } from '@genoffice/project-store'
import type { DesktopApi } from '../shared/desktop-api'

/**
 * Reading a workbook's contents: cell values, formulas, recalculation, embedded media and
 * pivot definitions.
 *
 * All five are the Rust engine, reached over a request/response protocol — a child process
 * on the desktop, and the same crate as WASM in a browser (Phase 6b). The renderer's
 * `univer-sync.ts` and `WorkbookVisuals.tsx` call them on every viewport change, so they
 * are on the hot path and their shapes are deliberately identical on both hosts.
 */
export type SheetsWorkbookPort = Pick<
  DesktopApi,
  | 'readWorkbookRange'
  | 'readWorkbookFormulas'
  | 'recalcWorkbook'
  | 'readWorkbookMedia'
  | 'readPivotDefinition'
>

/**
 * Getting a workbook in and out, and the file-shaped operations around it.
 *
 * `selectWorkbook` is the open dialog; `saveWorkbookEdits` writes the pending edits back;
 * `writeWorkbookRecovery` is the best-effort crash copy that never prompts and never
 * touches the opened file.
 *
 * `readLocalImage` is here rather than on `workbook` because it reads a file the workbook
 * does not contain: the AI's `add_image` op carries a path the user named in conversation.
 * A browser host has no such thing to resolve, which is a real capability difference rather
 * than a member to fake — see §8 of the migration doc.
 */
export type SheetsFilePort = Pick<
  DesktopApi,
  | 'selectWorkbook'
  | 'saveWorkbookEdits'
  | 'writeWorkbookRecovery'
  | 'autoRenameWorkbook'
  | 'closeWorkbook'
  | 'consumeNewBlankWorkbook'
  | 'readLocalImage'
>

/**
 * The window this renderer lives in, and the close guard around it.
 *
 * `notifyPendingEdits` is sheets' dirty signal and is a *count*, not a boolean — the main
 * process shows it in the close prompt ("3 unsaved changes"). It stays a count here: pdf's
 * `setDirty(boolean)` is a different signal, and coercing one into the other would throw
 * away what the prompt says.
 *
 * `openExternal` is required rather than nullable because both hosts really can do it: the
 * desktop hands the URL to the OS, a page opens a tab.
 */
export type SheetsWindowPort = Pick<
  DesktopApi,
  | 'notifyPendingEdits'
  | 'onCloseSaveRequest'
  | 'reportCloseSaveResult'
  | 'onWorkbookRenamed'
  | 'openExternal'
>

/** The UI language, and changes to it made elsewhere in the app. */
export type SheetsLanguagePort = Pick<DesktopApi, 'getLanguage' | 'onLanguageChanged'>

/**
 * The AI conversation: the settings the panel renders against, and the streaming calls.
 *
 * `setAiSettings` and `aiChat` are deliberately absent: the preload forwards both, and the
 * renderer calls neither (settings are edited in the shell, and the panel streams). A seam
 * claims what is used.
 */
export type SheetsAiPort = Pick<
  DesktopApi,
  'getAiSettings' | 'aiStream' | 'aiStreamCancel' | 'onAiStream'
>

/** Native application-menu commands (Open/Save/Save As/Export PDF/Undo/Redo). */
export type SheetsMenuPort = Pick<DesktopApi, 'onMenuAction'>

/** Printing the workbook to a PDF file. */
export type SheetsPdfExportPort = Pick<DesktopApi, 'exportPdf'>

/** Genspark account status and sign-in. */
export type SheetsGensparkPort = Pick<DesktopApi, 'aiGskStatus' | 'aiGskLogin'>

/** Web search, for the AI panel's search skill. */
export type SheetsSearchPort = Pick<DesktopApi, 'webSearch'>

/** sheets' composed platform. */
export interface SheetsPlatform {
  workbook: SheetsWorkbookPort
  file: SheetsFilePort
  window: SheetsWindowPort
  language: SheetsLanguagePort
  ai: SheetsAiPort
  /**
   * Chat attachments, ref-based.
   *
   * The shared `AttachmentsPort`, not a `Pick` of `DesktopApi`: sheets was the last app
   * declaring its own path-based copy (§6.3), and `getPathForFile(file: File): string` was
   * the sharp edge — a browser has nothing to return but `''`, which type-checks as a path.
   * The bridge stays path-based, because the main process addresses attachments by path;
   * the ref↔path mapping happens in the Electron adapter.
   */
  attachments: AttachmentsPort
  menu: SheetsMenuPort | null
  pdfExport: SheetsPdfExportPort | null
  genspark: SheetsGensparkPort | null
  search: SheetsSearchPort | null
  project: ProjectApi | null
}

/**
 * What a host module must export as `createSheetsPlatform`.
 *
 * The build-time seam: `main.tsx` imports it from the bare specifier `@host`, which each
 * Vite config aliases to exactly one host, so an Electron bundle carries no browser code
 * and a web bundle no reference to `window.desktopApi`.
 */
export type CreateSheetsPlatform = () => Promise<SheetsPlatform>

export const { set: setSheetsPlatform, get: sheetsPlatform } =
  createPlatformSlot<SheetsPlatform>('sheets')

// Per-port accessors for the required ports, so a call site reads
// `sheetsWorkbook().readWorkbookRange(op)` rather than
// `sheetsPlatform().workbook.readWorkbookRange(op)`. The nullable ports deliberately have
// none: their callers must hold the port and test it, which is the point of the null.
export const sheetsWorkbook = (): SheetsWorkbookPort => sheetsPlatform().workbook
export const sheetsFile = (): SheetsFilePort => sheetsPlatform().file
export const sheetsWindow = (): SheetsWindowPort => sheetsPlatform().window
export const sheetsLanguage = (): SheetsLanguagePort => sheetsPlatform().language
export const sheetsAi = (): SheetsAiPort => sheetsPlatform().ai
export const sheetsAttachments = (): AttachmentsPort => sheetsPlatform().attachments
