/**
 * pdf's platform slot: the one place the renderer names the host capabilities
 * it needs, and the only thing renderer code is allowed to reach the host
 * through.
 *
 * The composition is exactly what the renderer calls, no more:
 *
 *   - `language` — the shared LanguagePort (main.tsx boot language, locale.tsx
 *     live switching).
 *   - `ai` — the shared AiPort only. The AI panel reads settings and streams;
 *     it never writes settings, never makes a one-shot aiChat call and has no
 *     Genspark surface, and those ports have no ipcMain handler behind them
 *     when pdf runs standalone anyway (see @genoffice/platform's ports/ai.ts).
 *   - `window` — the dirty/close-guard slice of WindowPort plus pdf's Save As
 *     handshake. pdf claims no tab channels: its preload forwards none, and in
 *     standalone mode there is no shell tab strip to drive.
 *   - `file` — pdf's own document surface, which is app-specific by design and
 *     so is declared here rather than in @genoffice/platform. Requests are
 *     declared here too, keyed by an opaque DocumentRef; the result types still
 *     come from shared/ipc, since the renderer only reads `ok`/`error` from
 *     them and the paths they carry are the host's own bookkeeping.
 *
 * Ports not composed in, and why: `search`, `attachments` and `project` have no
 * call site in this renderer.
 */
import { createPlatformSlot, type Platform, type WindowPort } from '@genoffice/platform'
import type { PdfEditRequest } from '@genoffice/pdf-edit'
import type {
  ExportImagesRequest,
  ExportImagesResult,
  ExtractPagesResult,
  InsertPdfResult,
  SavePdfResult,
} from '../shared/ipc'

/**
 * Opaque handle to the open document. The renderer must never parse, split or
 * display it: Electron uses the absolute path, the web host uses a key into its
 * IndexedDB handle store. Only the host that issued a ref may interpret it.
 */
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
   * Human-readable location for display only (tooltips, "recent files"), or
   * undefined when the host has none. Never parsed, never passed back to the
   * host — use `ref` for that. Electron supplies the absolute path; a browser
   * host may supply nothing, since File System Access handles expose no path.
   *
   * Optional on purpose, and not a breach of this seam's no-optional-members
   * rule: that rule bans optional *methods*, which let a host claim a
   * capability and silently no-op it. This is a *data* field describing
   * something a host genuinely may not possess, and every consumer has to
   * handle its absence explicitly.
   */
  location?: string
}

/** Write the pending edits to the document behind `ref`. */
export interface SaveDocumentRequest extends PdfEditRequest {
  ref: DocumentRef
  /**
   * Save As destination, issued by the host (its own ref namespace). When set,
   * `ref` is only read and the result goes to `target` — the open document must
   * never be mutated.
   */
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

/**
 * pdf's document surface: reading the document being viewed and writing it back.
 *
 * Ref-based, not path-based: browsers have no file paths, so the host issues an
 * opaque `DocumentRef` and is the only side that resolves it. The Electron
 * adapter passes its absolute path through as the ref; the web host will hand
 * out keys for File System Access handles.
 */
export interface PdfFilePort {
  /** Take the document pending for this view (queued at tab creation); null if none. */
  consumePending(): Promise<PendingDocument | null>
  /**
   * Let the *renderer* start an open, or `null` when this host does not offer
   * one. Must be called from a user gesture: a browser only shows its file
   * picker from one. Returns null when the user dismisses the dialog.
   *
   * Null-valued rather than an optional method, and the distinction matters
   * here for the same reason it does for `PendingDocument.location`. An
   * optional method would let a host claim the capability and silently no-op
   * it, so the renderer would show an Open button that does nothing. A
   * *required key* holding either a function or `null` cannot be faked: the
   * renderer has to test it before it can call it, so the button exists exactly
   * when opening works. There is no no-op stub anywhere.
   *
   * Electron's is `null`: nothing in pdf's preload or main process opens a
   * document on the renderer's behalf — the shell owns file opening and queues
   * the result as a pending document — so the placeholder there stays exactly
   * as it was. A browser has no shell, so its host supplies the function.
   */
  openDocument: (() => Promise<PendingDocument | null>) | null
  /** Read pdf bytes. Only refs this view was granted are allowed. */
  readFile(ref: DocumentRef): Promise<ArrayBuffer>
  save(request: SaveDocumentRequest): Promise<SavePdfResult>
  extractPages(request: ExtractPagesDocumentRequest): Promise<ExtractPagesResult>
  insertPdf(request: InsertPdfDocumentRequest): Promise<InsertPdfResult>
  exportImages(request: ExportImagesRequest): Promise<ExportImagesResult>
}

/**
 * Host/window integration for pdf.
 *
 * The first three members are the shared WindowPort's dirty-state and
 * close-guard handshake, narrowed: pdf backs those and not the tab channels.
 * The Save As trio is pdf-only (the shell menu drives it), so it is declared
 * here — same host-request/renderer-reply shape as the close guard, hence the
 * same grouping.
 */
export type PdfWindowPort = Pick<
  WindowPort,
  'setDirty' | 'onCloseSaveRequest' | 'reportCloseSaveResult'
> & {
  /**
   * Shell menu Save As: write pending edits to the destination the host picked,
   * then reply. The renderer only relays the ref back through `file.save`.
   */
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

/**
 * What a host module must export as `createPdfPlatform`.
 *
 * This is the build-time seam. `main.tsx` imports `createPdfPlatform` from the
 * bare specifier `@host`, which each Vite config aliases to exactly one of
 * `host-electron.ts` or `host-web.ts`, so the two bundles contain disjoint host
 * code and neither carries a runtime check for which one it is. Async because a
 * browser host has to open IndexedDB before it can resolve a `DocumentRef`.
 */
export type CreatePdfPlatform = () => Promise<PdfPlatform>

export const { set: setPdfPlatform, get: pdfPlatform } = createPlatformSlot<PdfPlatform>('pdf')
