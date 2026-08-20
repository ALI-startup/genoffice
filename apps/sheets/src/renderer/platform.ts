/**
 * sheets' host seam: the capabilities the renderer needs, grouped by what a host must actually be
 * able to do, and the slot that holds one host's answer.
 */
import { createPlatformSlot, type AttachmentsPort } from '@samugen/platform'
import type { ProjectApi } from '@samugen/project-store'
import type { DesktopApi } from '../shared/desktop-api'

/**
 * Reading a workbook's contents: cell values, formulas, recalculation, embedded media and pivot
 * definitions.
 */
export type SheetsWorkbookPort = Pick<
  DesktopApi,
  | 'readWorkbookRange'
  | 'readWorkbookFormulas'
  | 'recalcWorkbook'
  | 'readWorkbookMedia'
  | 'readPivotDefinition'
>

/** Getting a workbook in and out, and the file-shaped operations around it. */
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

/** The window this renderer lives in, and the close guard around it. */
export type SheetsWindowPort = Pick<
  DesktopApi,
  | 'notifyPendingEdits'
  | 'onCloseSaveRequest'
  | 'reportCloseSaveResult'
  | 'onWorkbookRenamed'
  | 'openExternal'
>

/** The UI language: the current one, switching it, and switches made elsewhere in the app. */
export type SheetsLanguagePort = Pick<
  DesktopApi,
  'getLanguage' | 'onLanguageChanged' | 'setLanguage'
>

/** The AI conversation: the settings the panel renders against, and the streaming calls. */
export type SheetsAiPort = Pick<
  DesktopApi,
  'getAiSettings' | 'aiStream' | 'aiStreamCancel' | 'onAiStream'
>

/** Native application-menu commands (Open/Save/Save As/Export PDF/Undo/Redo). */
export type SheetsMenuPort = Pick<DesktopApi, 'onMenuAction'>

/** Printing the workbook to a PDF file. */
export type SheetsPdfExportPort = Pick<DesktopApi, 'exportPdf'>

/** Web search, for the AI panel's search skill. */
export type SheetsSearchPort = Pick<DesktopApi, 'webSearch'>

/** sheets' composed platform. */
export interface SheetsPlatform {
  workbook: SheetsWorkbookPort
  file: SheetsFilePort
  window: SheetsWindowPort
  language: SheetsLanguagePort
  ai: SheetsAiPort
  /** Chat attachments, ref-based. */
  attachments: AttachmentsPort
  menu: SheetsMenuPort | null
  pdfExport: SheetsPdfExportPort | null
  search: SheetsSearchPort | null
  project: ProjectApi | null
}

/** What a host module must export as `createSheetsPlatform`. */
export type CreateSheetsPlatform = () => Promise<SheetsPlatform>

export const { set: setSheetsPlatform, get: sheetsPlatform } =
  createPlatformSlot<SheetsPlatform>('sheets')

// Per-port accessors for the required ports, so a call site reads
// `sheetsWorkbook().readWorkbookRange(op)` rather than
// `sheetsPlatform().workbook.readWorkbookRange(op)`.
export const sheetsWorkbook = (): SheetsWorkbookPort => sheetsPlatform().workbook
export const sheetsFile = (): SheetsFilePort => sheetsPlatform().file
export const sheetsWindow = (): SheetsWindowPort => sheetsPlatform().window
export const sheetsLanguage = (): SheetsLanguagePort => sheetsPlatform().language
export const sheetsAi = (): SheetsAiPort => sheetsPlatform().ai
export const sheetsAttachments = (): AttachmentsPort => sheetsPlatform().attachments
