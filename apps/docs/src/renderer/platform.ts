/**
 * docs' platform slot: the one place the renderer names the host capabilities it needs, and the
 * only thing renderer code is allowed to reach the host through.
 */
import {
  createPlatformSlot,
  type Platform,
  type SearchPort,
  type WindowPort,
} from '@samugen/platform'
import type { MenuCommand, PickImageResult } from '../shared/ipc'

/** Opaque handle to a document, issued by the host. */
export type DocumentRef = string

/** A document the host handed over: the handle, what to call it, and its bytes. */
export interface OpenedDocument {
  ref: DocumentRef
  /**
   * Display name, e.g. `report.docx`. The host supplies it because the renderer
   * cannot derive one from an opaque ref; it drives the title bar, the shell tab
   * title and the default export/print file name.
   */
  name: string
  /** Raw docx bytes. */
  data: ArrayBuffer
  /** sha256 of the file as opened; the host archives the original under this hash. */
  hash: string
}

/** A file that reached the editor as content rather than as bytes. */
export interface ImportedDocument {
  /**
   * The document body as a restricted HTML fragment: `h1`–`h6`, `p`, `ul`/`ol`/`li`,
   * `strong`/`em`/`u`/`s`, `a`, `br` and tables.
   */
  html: string
  /**
   * Paragraph alignment, one entry per top-level block of `html`, because the fragment's tag set
   * has nowhere to carry it.
   */
  align: ReadonlyArray<'center' | 'right' | 'justify' | null>
  /** Pictures the fragment could not carry. */
  droppedImages: number
  /** Name of the source file, e.g. `report.hwpx`, for the status message. */
  sourceName: string
  /** What to call the document, e.g. `report.hwpx`. */
  name: string
  /** The file this document saves over, or null when there is none to save over. */
  ref: DocumentRef | null
  /** What an in-place save encodes. */
  format: 'hwpx'
}

/** What an open request produced. */
export type OpenOutcome =
  { kind: 'document'; document: OpenedDocument } | { kind: 'import'; imported: ImportedDocument }

/** A document the host renamed underneath us (renamed in the shell Home list). */
export interface DocumentRenamed {
  /** The ref the renderer currently holds. */
  ref: DocumentRef
  /** Its replacement — the same document under a new handle. */
  newRef: DocumentRef
  /** The new display name, supplied by the host. */
  newName: string
}

/** One entry of the host's recent-documents list. */
export interface RecentDocument {
  ref: DocumentRef
  /** Display name, supplied by the host — a ref is not parseable. */
  name: string
  /** Human-readable location for display only (tooltips), or undefined when the host has none. */
  location?: string
}

/** Outcome of writing to a document the renderer already had a ref for. */
export interface SaveDocumentResult {
  ok: boolean
  error?: string
  /** Why the write did not happen, when the reason is neither an error nor a cancellation. */
  reason?: 'external-modified' | 'needs-permission'
}

/**
 * Outcome of a save that had to *name* the document (Save As, or the silent first save of a
 * never-saved one).
 */
export interface SaveNamedDocumentResult {
  ok: boolean
  ref?: DocumentRef
  /** Display name of the destination, supplied by the host. */
  name?: string
  error?: string
  /**
   * Why a `saveNew` could not run, when the reason is neither an error nor a user's cancellation.
   */
  reason?: 'needs-user-gesture'
}

/** docs' document surface: getting docx bytes in and writing them back out. */
export interface DocsFilePort {
  /** Take the document the host queued for this view at tab creation; null if none. */
  consumePending(): Promise<OpenOutcome | null>
  /** Take the one-shot "this tab was created blank" flag. */
  consumeNewBlank(): Promise<boolean>
  /** Documents the host opens while the app is running (Finder/Explorer). */
  onOpenDocument(handler: (opened: OpenOutcome) => void): () => void
  /** The host renamed the open document; the renderer re-points its ref and title. */
  onDocumentRenamed(handler: (change: DocumentRenamed) => void): () => void
  /** Host open dialog; null when the user dismisses it. */
  openDocument(): Promise<OpenOutcome | null>
  /** Re-open a ref the host issued earlier (a recent entry, or a menu open-path payload). */
  openDocumentByRef(ref: DocumentRef): Promise<OpenOutcome | null>
  /** Overwrite the document behind `ref`. `auto` marks an autosave (no dialogs). */
  save(ref: DocumentRef, data: ArrayBuffer, auto?: boolean): Promise<SaveDocumentResult>
  /** Save As: the host picks the destination and names it. */
  saveAs(defaultName: string, data: ArrayBuffer): Promise<SaveNamedDocumentResult>
  /** First save of a never-saved document: silent, into the host's default location. */
  saveNew(defaultName: string, data: ArrayBuffer, auto: boolean): Promise<SaveNamedDocumentResult>
  /** Crash-recovery copy of a dirty document, kept by the host outside the document itself. */
  writeRecoveryCopy(ref: DocumentRef, data: ArrayBuffer): Promise<{ ok: boolean }>
  /** Does this host keep crash-recovery state at all? */
  crashRecovery: boolean
  /** The host's recent-documents list. */
  recentDocuments(): Promise<RecentDocument[]>
  /** Host image picker, for inserting/replacing a picture; null on cancel. */
  pickImage(): Promise<PickImageResult | null>
}

/** The renderer's answer to the host's pre-close question. */
export interface CloseCheckState {
  dirty: boolean
  autoSave: boolean
  /** The open document's handle, or null when it has never been saved. */
  ref: DocumentRef | null
}

/** The shared WindowPort's tab channels, as their own port. */
export type DocsTabsPort = Pick<WindowPort, 'openNewTab' | 'listTabs' | 'focusTab'>

/** Host/window integration for docs. */
export type DocsWindowPort = Pick<WindowPort, 'onCloseSaveRequest' | 'reportCloseSaveResult'> & {
  /** Whether the host draws the window frame and the application menu itself. */
  nativeChrome: boolean
  /** The host is about to close this view and wants the renderer's decision. */
  onCloseCheck(handler: () => void): () => void
  /** Answer the close check. Exactly one reply per request; see onCloseCheck on timing. */
  reportCloseCheck(state: CloseCheckState): void
  /**
   * This view was detached but kept alive (the shell keeps closed tabs' contents
   * around to avoid a freeze); stop background timers.
   */
  onTeardown(handler: () => void): () => void
  /** Commands dispatched from the host's application menu. */
  onMenuCommand(handler: (command: MenuCommand, payload?: string) => void): () => void
}

/** One PDF fragment rendered by the host, as base64. */
export interface PdfFragmentResult {
  ok: boolean
  base64?: string
  error?: string
}

/** Outcome of writing a PDF: `path` is display-only (it goes straight into a status message). */
export interface PdfWriteResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * Rendering the document to PDF: Export PDF, and the mixed-paper-size path that prints one fragment
 * per paper size and merges them in page order.
 */
export interface DocsPdfExportPort {
  /** Render the whole document at one paper size and write it out; the host picks the destination. */
  exportPdf(
    defaultName: string,
    pageWidthTwips: number,
    pageHeightTwips: number,
    /** Only honored when a previous export dialog chose exactly this destination. */
    outPath?: string,
  ): Promise<PdfWriteResult>
  /** Render the currently-visible pages at one paper size and hand back the bytes. */
  printPdfBuffer(pageWidthTwips: number, pageHeightTwips: number): Promise<PdfFragmentResult>
  /** Merge fragments in page order and write the result out. */
  saveMergedPdf(
    defaultName: string,
    base64Parts: string[],
    outPath?: string,
  ): Promise<PdfWriteResult>
}

/** Handing the current view to the host's own print flow. */
export interface DocsPrintPort {
  /** Open the host's print flow for the current view. */
  print(): Promise<void>
}

/** Outcome of writing an exported file: `path` is display-only. */
export interface HwpxExportResult {
  ok: boolean
  path?: string
  error?: string
}

/** Turning the document into `.hwpx` bytes — to write elsewhere, or to save. */
export interface DocsHwpxPort {
  /** Convert a restricted HTML fragment to `.hwpx` and let the host write it out. */
  exportDocument(defaultName: string, html: string): Promise<HwpxExportResult>
  /** Convert a restricted HTML fragment to `.hwpx` bytes, and write nothing. */
  convert(html: string): Promise<ArrayBuffer>
}

/** Outcome of handing the document to the user as a download. */
export interface DownloadResult {
  ok: boolean
  /** Name the file was delivered under, for the status message. */
  name?: string
  error?: string
}

/** Handing the document's current bytes to the user as a download. */
export interface DocsDownloadPort {
  /** Deliver `data` to the user under `defaultName`. */
  download(defaultName: string, data: ArrayBuffer): Promise<DownloadResult>
}

/** docs' composed platform. */
export type DocsPlatform = Platform<'language' | 'ai' | 'attachments'> & {
  search: SearchPort | null
  window: DocsWindowPort
  file: DocsFilePort
  tabs: DocsTabsPort | null
  pdfExport: DocsPdfExportPort | null
  print: DocsPrintPort | null
  /** HWPX export, or `null` on a host that cannot convert. */
  hwpx: DocsHwpxPort | null
  /** Copying the document out as a download, or `null` on a host that writes real files instead. */
  download: DocsDownloadPort | null
}

/** What a host module must export as `createDocsPlatform`. */
export type CreateDocsPlatform = () => Promise<DocsPlatform>

export const { set: setDocsPlatform, get: docsPlatform } = createPlatformSlot<DocsPlatform>('docs')
