/**
 * pdf's platform slot: the one place the renderer names the host capabilities it needs, and the
 * only thing renderer code is allowed to reach the host through.
 */
import { createPlatformSlot, type Platform, type WindowPort } from '@samugen/platform'
import type { PdfEditRequest } from '@samugen/pdf-edit'
import type {
  ExportImagesRequest,
  ExportImagesResult,
  ExtractPagesResult,
  InsertPdfResult,
  SavePdfResult,
} from '../shared/ipc'

/** Opaque handle to the open document. */
export type DocumentRef = string

/** A document the host queued for this view: the handle plus what to call it. */
export interface PendingDocument {
  ref: DocumentRef
  /**
   * Display name, e.g. `report.pdf`. The host supplies it because the renderer
   * cannot derive one from an opaque ref; it drives the title bar and the base
   * name of exported images and extracted pages.
   */
  name: string
  /**
   * Human-readable location for display only (tooltips, "recent files"), or undefined when the host
   * has none.
   */
  location?: string
}

/** Write the pending edits to the document behind `ref`. */
export interface SaveDocumentRequest extends PdfEditRequest {
  ref: DocumentRef
  /** Save As destination, issued by the host (its own ref namespace). */
  target?: DocumentRef
}

/** Extract pages into a new document; the host picks the destination and may cancel. */
export interface ExtractPagesDocumentRequest {
  ref: DocumentRef
  /** Original page indices */
  pages: number[]
  suggestedName: string
}

/** Merge another document the host picks into the open one. */
export interface InsertPdfDocumentRequest {
  ref: DocumentRef
  /** Insert after this original page index; -1 means front of the document */
  afterPageIndex: number
}

/** pdf's document surface: reading the document being viewed and writing it back. */
export interface PdfFilePort {
  /** Take the document pending for this view (queued at tab creation); null if none. */
  consumePending(): Promise<PendingDocument | null>
  /** Let the *renderer* start an open, or `null` when this host does not offer one. */
  openDocument: (() => Promise<PendingDocument | null>) | null
  /** Read pdf bytes. Only refs this view was granted are allowed. */
  readFile(ref: DocumentRef): Promise<ArrayBuffer>
  save(request: SaveDocumentRequest): Promise<SavePdfResult>
  extractPages(request: ExtractPagesDocumentRequest): Promise<ExtractPagesResult>
  insertPdf(request: InsertPdfDocumentRequest): Promise<InsertPdfResult>
  exportImages(request: ExportImagesRequest): Promise<ExportImagesResult>
}

/** Host/window integration for pdf. */
export type PdfWindowPort = Pick<
  WindowPort,
  'setDirty' | 'onCloseSaveRequest' | 'reportCloseSaveResult'
> & {
  /** Shell menu Save As: write pending edits to the destination the host picked, then reply. */
  onSaveAsRequest(handler: (target: DocumentRef) => void): () => void
  /** Named for symmetry with reportCloseSaveResult; the bridge calls it sendSaveAsResult. */
  reportSaveAsResult(ok: boolean): void
  /** True while the shell's Save As flow (dialog included) is open; autosave pauses. */
  onSaveAsFlow(handler: (inFlight: boolean) => void): () => void
}

export type PdfPlatform = Platform<'language' | 'ai'> & {
  window: PdfWindowPort
  file: PdfFilePort
}

/** What a host module must export as `createPdfPlatform`. */
export type CreatePdfPlatform = () => Promise<PdfPlatform>

export const { set: setPdfPlatform, get: pdfPlatform } = createPlatformSlot<PdfPlatform>('pdf')
