/**
 * docs' platform slot: the one place the renderer names the host capabilities it
 * needs, and the only thing renderer code is allowed to reach the host through.
 * After this phase the preload global is read in exactly one place —
 * host-electron.ts, the module `main.tsx` bootstraps from — and nowhere else in
 * the renderer. Same arrangement as apps/pdf.
 *
 * The composition is exactly what the renderer calls, no more:
 *
 *   - `language` — the shared LanguagePort (main.tsx boot language, locale.tsx
 *     live switching).
 *   - `ai` — the shared AiPort in full: App.tsx reads settings, ai/transport.ts
 *     streams and cancels.
 *   - `attachments` — the chat attachment surface, ref-based since Phase 4a.
 *   - `window` — the close-guard reply half of the shared WindowPort, plus the
 *     host→renderer channels that are docs' alone (the close *check*, teardown
 *     and the native menu). See DocsWindowPort.
 *   - `file` — docs' own docx document surface, app-specific by design (the same
 *     division apps/pdf uses) and therefore declared here.
 *   - `tabs` — the shared WindowPort's tab channels, or `null` on a host with no
 *     tab strip.
 *   - `search` — web/image search and the image download behind the AI tools, or
 *     `null` on a host that cannot reach a search backend.
 *   - `genspark` — the sign-in surface in the AI panel (status probe on a failed
 *     run, plus the inline sign-in button), or `null` on a host with no Genspark
 *     integration.
 *   - `pdfExport` — PDF export/print, or `null` on a host that has none.
 *   - `print` — handing the current view to the host's print flow, or `null` on a
 *     host whose print flow the renderer does not drive.
 *
 * Five of those are `X | null`. Four are capabilities the web host (Phase 4b)
 * genuinely cannot back, and the fifth (`print`) runs the other way: it is the
 * Electron host that leaves it null, because there printing belongs to the native
 * application menu. See `DocsPlatform` for why each is nullable rather than
 * optional, and host-web.ts / platform-electron.ts for why each is null there.
 *
 * Ports deliberately left out, and why:
 *   - `aiSettings` (setAiSettings) — docs' preload forwards 'ai:set-settings'
 *     but no docs renderer code calls it; AI settings are edited in the shell.
 *   - `aiChat` — same: forwarded, never called. docs' AI surface is streaming
 *     only.
 *   - `project` — `window.projectApi` has zero call sites reachable through a
 *     port here: the AI panel talks to it directly and the store is
 *     main-process-only. Wiring ProjectPort would be claiming a capability
 *     nothing consumes through the seam.
 *   - `WindowPort.setDirty` — docs' preload exposes no such channel. Its host
 *     pulls the dirty state at close time instead of being pushed it, which is
 *     the whole reason for the close-check pair below.
 */
import {
  createPlatformSlot,
  type GensparkPort,
  type Platform,
  type SearchPort,
  type WindowPort,
} from '@genoffice/platform'
import type { MenuCommand, PickImageResult } from '../shared/ipc'

/**
 * Opaque handle to a document, issued by the host.
 *
 * The renderer stores it, compares it for identity and hands it back — nothing
 * more. It must never be parsed, split, displayed or built: Electron's happens
 * to be an absolute path, a browser host's would be a key into its own handle
 * store, and only the host that issued a ref may interpret it. Anything the UI
 * has to show comes from a sibling `name` / `location` field, exactly as with
 * `DocumentRef` in apps/pdf and `AttachmentRef` in @genoffice/platform.
 */
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

/** A document the host renamed underneath us (renamed in the shell Home list). */
export interface DocumentRenamed {
  /** The ref the renderer currently holds. */
  ref: DocumentRef
  /** Its replacement — the same document under a new handle. */
  newRef: DocumentRef
  /**
   * The new display name, supplied by the host.
   *
   * Present because the renderer used to compute it by splitting `newPath` on
   * path separators (App.tsx), which is the same defect class as pdf's old
   * basename-from-path derivation: correct only while a ref happens to be a
   * path.
   */
  newName: string
}

/** One entry of the host's recent-documents list. */
export interface RecentDocument {
  ref: DocumentRef
  /** Display name, supplied by the host — a ref is not parseable. */
  name: string
  /**
   * Human-readable location for display only (tooltips), or undefined when the
   * host has none. Never parsed, never passed back to the host — use `ref`.
   */
  location?: string
}

/** Outcome of writing to a document the renderer already had a ref for. */
export interface SaveDocumentResult {
  ok: boolean
  error?: string
  /**
   * The file changed on disk since it was opened. The host has already
   * prompted (or, for an autosave, deferred to the next manual save), so the
   * renderer must not show a second dialog for this reason.
   */
  reason?: 'external-modified'
}

/**
 * Outcome of a save that had to *name* the document (Save As, or the silent
 * first save of a never-saved one).
 *
 * `ref` and `name` are absent when the host cancelled without error — a
 * dismissed Save As dialog reports `ok: false` with no error.
 */
export interface SaveNamedDocumentResult {
  ok: boolean
  ref?: DocumentRef
  /** Display name of the destination, supplied by the host. */
  name?: string
  error?: string
  /**
   * Why a `saveNew` could not run, when the reason is neither an error nor a
   * user's cancellation.
   *
   * `needs-user-gesture`: this host can only name a document through a dialog, and
   * the dialog may only open from a user gesture — so a save reached from a timer
   * (the recovery tick, the post-AI-run auto-name) genuinely cannot proceed.
   * Nothing was written and nothing failed.
   *
   * It exists so that outcome is *distinguishable*. Without it the caller sees a
   * plain `{ ok: false }`, reports nothing, and the user is left believing a
   * never-saved document is being autosaved when it is not — a save that resolves
   * without writing and without saying so. The renderer therefore reports this
   * case as its own status message rather than as a failure.
   */
  reason?: 'needs-user-gesture'
}

/**
 * docs' document surface: getting docx bytes in and writing them back out.
 *
 * Ref-based, not path-based: browsers have no file paths, so the host issues an
 * opaque `DocumentRef` and is the only side that resolves it. The Electron
 * adapter passes its absolute path through as the ref.
 */
export interface DocsFilePort {
  /** Take the document the host queued for this view at tab creation; null if none. */
  consumePending(): Promise<OpenedDocument | null>
  /** Take the one-shot "this tab was created blank" flag. */
  consumeNewBlank(): Promise<boolean>
  /** Documents the host opens while the app is running (Finder/Explorer). */
  onOpenDocument(handler: (opened: OpenedDocument) => void): () => void
  /** The host renamed the open document; the renderer re-points its ref and title. */
  onDocumentRenamed(handler: (change: DocumentRenamed) => void): () => void
  /** Host open dialog; null when the user dismisses it. */
  openDocument(): Promise<OpenedDocument | null>
  /** Re-open a ref the host issued earlier (a recent entry, or a menu open-path payload). */
  openDocumentByRef(ref: DocumentRef): Promise<OpenedDocument | null>
  /** Overwrite the document behind `ref`. `auto` marks an autosave (no dialogs). */
  save(ref: DocumentRef, data: ArrayBuffer, auto?: boolean): Promise<SaveDocumentResult>
  /** Save As: the host picks the destination and names it. */
  saveAs(defaultName: string, data: ArrayBuffer): Promise<SaveNamedDocumentResult>
  /** First save of a never-saved document: silent, into the host's default location. */
  saveNew(defaultName: string, data: ArrayBuffer): Promise<SaveNamedDocumentResult>
  /** Crash-recovery copy of a dirty document, kept by the host outside the document itself. */
  writeRecoveryCopy(ref: DocumentRef, data: ArrayBuffer): Promise<{ ok: boolean }>
  /** The host's recent-documents list. */
  recentDocuments(): Promise<RecentDocument[]>
  /** Host image picker, for inserting/replacing a picture; null on cancel. */
  pickImage(): Promise<PickImageResult | null>
}

/**
 * The renderer's answer to the host's pre-close question.
 *
 * This is a *decision*, not a dirty bit, which is why docs cannot use
 * `WindowPort.setDirty`. `setDirty` is a push the host remembers; this is a pull
 * the host performs once, at close time, and all three fields feed the host's
 * branch: `dirty` decides whether to prompt at all, `autoSave` says the user has
 * opted into saving silently instead of being asked, and `ref` is what the host
 * resolves to clean up the recovery copy on "Don't Save". Neither protocol can
 * be derived from the other — a boolean cannot carry a preference or a handle —
 * so the pair is declared here rather than coerced into the shared port.
 */
export interface CloseCheckState {
  dirty: boolean
  autoSave: boolean
  /**
   * The open document's handle, or null when it has never been saved.
   *
   * Was `filePath`. The renderer only relays back a ref the host itself issued;
   * named for that so no caller is invited to build one.
   */
  ref: DocumentRef | null
}

/**
 * The shared WindowPort's tab channels, as their own port.
 *
 * Split out of `DocsWindowPort` in Phase 4b, because a browser tab cannot back
 * them: `listTabs` would have to enumerate the other tabs of this origin and
 * `focusTab` would have to raise one, and a page may do neither. (`openNewTab`
 * alone is expressible as `window.open`, but the trio is one UI — the ribbon's
 * Window group — and a "switch tabs" menu that can list nothing is not a
 * capability, so all three move together.)
 *
 * The three channels are registered by docs-main and the shell owns the tab
 * strip, so any shell-hosted adapter backs the whole port; see
 * @genoffice/platform's ports/window.ts.
 */
export type DocsTabsPort = Pick<WindowPort, 'openNewTab' | 'listTabs' | 'focusTab'>

/**
 * Host/window integration for docs.
 *
 * The first two members are the shared WindowPort narrowed to what docs' preload
 * forwards and every host can honour: the reply half of the close guard that all
 * four apps share. `setDirty` is absent on purpose (see the file header), and the
 * tab channels moved to `DocsTabsPort`.
 *
 * The rest are host→renderer channels docs alone has. They are grouped here
 * rather than split into three one-method ports because they are one kind of
 * thing — the host driving this window — and they share the close guard's
 * request/reply shape. Same grouping decision as `PdfWindowPort`, which folds
 * pdf's Save As handshake in beside the shared close guard.
 */
export type DocsWindowPort = Pick<WindowPort, 'onCloseSaveRequest' | 'reportCloseSaveResult'> & {
  /**
   * The host is about to close this view and wants the renderer's decision.
   *
   * Handlers must reply *synchronously* — call `reportCloseCheck` before
   * returning. Electron does not require it (the request arrives over IPC and the
   * reply goes back over IPC), but the web host emits this from `beforeunload`,
   * where the answer has to be in hand before the listener returns or the browser
   * has already decided. The one handler in this renderer (App.tsx) does reply
   * synchronously, and the state it reports is kept in refs precisely so it can.
   */
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
 * Rendering the document to PDF: Export PDF, and the mixed-paper-size path that
 * prints one fragment per paper size and merges them in page order.
 *
 * All three members are required, because a host that can render a fragment but
 * not merge fragments cannot export a mixed-paper document at all — the flow in
 * file-actions.ts needs the whole set or none of it. Which is why the platform
 * makes the *port* nullable instead (see `DocsPlatform.pdfExport`): one honest
 * decision at one call site, rather than three that can disagree.
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

/**
 * Handing the current view to the host's own print flow.
 *
 * Deliberately *not* a member of `DocsPdfExportPort`, and not a nullable method
 * on it either. The two are different operations that happen to both end in
 * paper-shaped output:
 *
 *   - `DocsPdfExportPort` renders the document to a *file*. It takes a paper size
 *     and a destination, reports the path it wrote, and — for a mixed-paper
 *     document — renders per size and merges. Nothing about it is user-facing
 *     while it runs.
 *   - `DocsPrintPort` opens the host's print UI over whatever is currently
 *     rendered. There is no destination, no bytes come back, and the user may
 *     cancel; the host decides everything after the call.
 *
 * Folding print into the export port would also mean a host has to supply both or
 * neither, and the two hosts split exactly the other way: Electron exports and
 * does not print through the renderer, the browser prints and does not export. So
 * they are two ports, each nullable on its own, and every `pdfExport` call site in
 * file-actions.ts is untouched by print existing.
 */
export interface DocsPrintPort {
  /**
   * Open the host's print flow for the current view.
   *
   * Resolves once the host is done with it — printed *or* cancelled, which the
   * caller cannot tell apart and does not need to: the point of the promise is
   * that nothing tears down what is on screen underneath a live print job.
   */
  print(): Promise<void>
}

/**
 * docs' composed platform.
 *
 * Five members are `X | null`, and the nullability is the whole design rather
 * than a convenience. An *optional* member would let a host claim a capability
 * and silently no-op it — the renderer would offer Export PDF and nothing would
 * happen, which is exactly how the hand-written web shims failed. A *required
 * key* holding either the port or `null` cannot be faked: the renderer has to
 * test it before it can use it, so each command exists exactly when it works.
 *
 * Why each one, and what the two hosts put there:
 *
 *   - `tabs` — Electron: the shell's tab strip. Web: `null`; a page cannot
 *     enumerate or focus the browser's other tabs.
 *   - `search` — Electron: the main process's Serper/DuckDuckGo/gsk client, which
 *     also sidesteps renderer CORS. Web: `null`; the search backends need a key
 *     the browser must never hold and an origin its CSP (`connect-src 'self'`)
 *     forbids, so this needs a server route the BFF does not yet have.
 *   - `genspark` — Electron: the gsk CLI (a local process) and a system browser
 *     sign-in. Web: `null`; a page can do neither.
 *   - `pdfExport` — Electron: the main process renders with `printToPDF` and
 *     merges with pdf-lib. Web: `null`, and it stays null. Phase 4c decided
 *     against a renderer-side exporter: rasterising pages to canvas or re-laying
 *     the text out with pdf-lib would produce a *different* document from the one
 *     the desktop exports, under the same command name. The browser prints
 *     instead, through `print` below, and Export PDF simply is not offered there.
 *   - `print` — Web: `window.print()`, over the pagination preview, with `@page`
 *     rules supplying the paper size Electron passes to `printToPDF` as an
 *     argument. Electron: `null`. Not because Chromium could not do it — it could
 *     — but because on the desktop printing is the *host's*: the native File menu
 *     owns the Print item and the main process answers it with
 *     `webContents.print()`. `DesktopApi.print()` is forwarded by the preload and
 *     has no renderer call site, and the `'print'` MenuCommand is not handled in
 *     App.tsx's switch, so the renderer genuinely does not drive printing there.
 *     Claiming it would add a second, differently-behaved print path to the
 *     desktop app; null says the truth and leaves the desktop exactly as it was.
 *
 * The Electron host backs all four of the first group, so nothing about the
 * desktop app changes.
 */
export type DocsPlatform = Platform<'language' | 'ai' | 'attachments'> & {
  window: DocsWindowPort
  file: DocsFilePort
  tabs: DocsTabsPort | null
  search: SearchPort | null
  genspark: GensparkPort | null
  pdfExport: DocsPdfExportPort | null
  print: DocsPrintPort | null
}

/**
 * What a host module must export as `createDocsPlatform`.
 *
 * This is the build-time seam. `main.tsx` imports `createDocsPlatform` from the
 * bare specifier `@host`, which each Vite config aliases to exactly one of
 * `host-electron.ts` or `host-web.ts`, so the two bundles contain disjoint host
 * code and neither carries a runtime check for which one it is. Async because a
 * browser host has to open IndexedDB before it can resolve a `DocumentRef`.
 */
export type CreateDocsPlatform = () => Promise<DocsPlatform>

export const { set: setDocsPlatform, get: docsPlatform } = createPlatformSlot<DocsPlatform>('docs')
