/** The Electron transport contract: preload channels and the payloads that cross them. */
import type { Lang } from '@samugen/i18n'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@samugen/ai-provider'
import type { PdfEditRequest } from '@samugen/pdf-edit'

export type {
  DrawingInput,
  FormValueInput,
  MarkupInput,
  MarkupType,
  MetadataInput,
  PdfEditRequest,
  StampInput,
} from '@samugen/pdf-edit'

export const PDF_CHANNELS = {
  consumePending: 'pdf:consume-pending',
  readFile: 'pdf:read-file',
  save: 'pdf:save',
  extractPages: 'pdf:extract-pages',
  insertPdf: 'pdf:insert-pdf',
  exportImages: 'pdf:export-images',
  dirtyChanged: 'pdf:dirty-changed',
  closeSaveRequest: 'pdf:close-save-request',
  closeSaveResult: 'pdf:close-save-result',
  saveAsRequest: 'pdf:save-as-request',
  saveAsResult: 'pdf:save-as-result',
  saveAsFlow: 'pdf:save-as-flow',
  getLanguage: 'app:get-language',
  setLanguage: 'app:set-language',
  languageChanged: 'app:language-changed',
} as const

/**
 * Save over the Electron transport: the host-agnostic edit payload plus the paths the main process
 * needs.
 */
export interface SavePdfRequest extends PdfEditRequest {
  path: string
  /**
   * Save As destination. When set, `path` is only read (source bytes) and the edited PDF
   * is written to this path instead — the original file must never be mutated.
   * Must match the target granted to the view by the main process (save dialog pick).
   */
  targetPath?: string
}

export type SavePdfResult = { ok: true } | { ok: false; error: string }

/** Extract pages into a new PDF: main process shows a save dialog; cancel returns canceled */
export interface ExtractPagesRequest {
  path: string
  /** Original page indices */
  pages: number[]
  suggestedName: string
}

export type ExtractPagesResult =
  { ok: true; savedPath: string } | { ok: true; canceled: true } | { ok: false; error: string }

/** Insert (merge) another PDF after a page of the current file: main process shows a picker and writes back immediately */
export interface InsertPdfRequest {
  path: string
  /** Insert after this original page index; -1 means front of the document */
  afterPageIndex: number
}

export type InsertPdfResult =
  { ok: true; insertedCount: number } | { ok: true; canceled: true } | { ok: false; error: string }

/** Export pages as PNG: renderer rasterizes the bitmaps, main process shows a dialog and writes to disk */
export interface ExportImagesRequest {
  /** base64 PNGs (without the data: prefix), in page order */
  images: string[]
  /** 1-based page numbers, same length as images, used for file names */
  pageNumbers: number[]
  baseName: string
}

export type ExportImagesResult =
  | { ok: true; savedDir: string; count: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** AI channels are app-wide shared ipcMain handlers (shell registers via docs-main registerAiIpc); pass-through only */
export const AI_CHANNELS = {
  getSettings: 'ai:get-settings',
  stream: 'ai:stream',
  streamChunk: 'ai:stream-chunk',
  streamCancel: 'ai:stream-cancel',
} as const

/** API exposed by preload to the renderer (window.pdfApi) */
export interface PdfApi {
  /** Take the pdf path pending for this view (queued at tab creation); null if none */
  consumePending(): Promise<string | null>
  /** Read pdf bytes. Only paths granted to this view are allowed */
  readFile(path: string): Promise<ArrayBuffer>
  /** Write markups/form values/page ops back to the original file (pdf-lib, content streams untouched); path grants same as readFile. With targetPath set (Save As), the original is only read and the result goes to targetPath */
  save(request: SavePdfRequest): Promise<SavePdfResult>
  extractPages(request: ExtractPagesRequest): Promise<ExtractPagesResult>
  insertPdf(request: InsertPdfRequest): Promise<InsertPdfResult>
  exportImages(request: ExportImagesRequest): Promise<ExportImagesResult>
  /** Mirror unsaved-changes state to the main process; drives the save prompt before closing a tab/window */
  setDirty(dirty: boolean): void
  /** Main process picked "Save" in the close prompt → renderer saves and replies via sendCloseSaveResult */
  onCloseSaveRequest(handler: () => void): () => void
  sendCloseSaveResult(ok: boolean): void
  /** Shell menu Save As → renderer writes pending edits to targetPath only (original untouched) and replies via sendSaveAsResult */
  onSaveAsRequest(handler: (targetPath: string) => void): () => void
  sendSaveAsResult(ok: boolean): void
  /** True while the shell's Save As flow (dialog included) is open — the renderer pauses autosave, since the dialog's window blur would otherwise trigger a save into the original */
  onSaveAsFlow(handler: (inFlight: boolean) => void): () => void
  getLanguage(): Promise<Lang>
  onLanguageChanged(handler: (lang: Lang) => void): () => void
  /** switch the UI language for the whole app; every other window hears it as onLanguageChanged */
  setLanguage(lang: Lang): Promise<void>
  getAiSettings(): Promise<AiSettings>
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}
