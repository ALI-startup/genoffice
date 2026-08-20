/**
 * docs' platform slot: the one place the renderer names the host capabilities it
 * needs, and the only thing renderer code is allowed to reach the host through.
 * After this phase the preload global is read in exactly one place —
 * host-web.ts, the module `main.tsx` bootstraps from — and nowhere else in
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
 *   - `pdfExport` — PDF export/print, or `null` on a host that has none.
 *   - `print` — handing the current view to the host's print flow, or `null` on a
 *     host whose print flow the renderer does not drive.
 *   - `hwpx` — writing the document out as `.hwpx`, or `null` on a host that
 *     cannot convert. Non-null on both hosts today.
 *   - `download` — copying the document out to the user's downloads, or `null` on
 *     a host whose Save As already writes a real file it keeps editing.
 *
 * Seven of those are `X | null`. Four are capabilities the web host (Phase 4b)
 * genuinely cannot back; `print` and `download` run the other way, because it is
 * the Electron host that leaves those null (there printing belongs to the native
 * application menu, and Save As is a better download than a download); and `hwpx`
 * is backed by both, kept nullable so a host that cannot convert has something
 * honest to report. See `DocsPlatform` for why each is nullable rather than
 * optional, and host-web.ts for why each is null.
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
  type Platform,
  type SearchPort,
  type WindowPort,
} from '@samugen/platform'
import type { MenuCommand, PickImageResult } from '../shared/ipc'

/**
 * Opaque handle to a document, issued by the host.
 *
 * The renderer stores it, compares it for identity and hands it back — nothing
 * more. It must never be parsed, split, displayed or built: Electron's happens
 * to be an absolute path, a browser host's would be a key into its own handle
 * store, and only the host that issued a ref may interpret it. Anything the UI
 * has to show comes from a sibling `name` / `location` field, exactly as with
 * `DocumentRef` in apps/pdf and `AttachmentRef` in @samugen/platform.
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

/**
 * A file that reached the editor as content rather than as bytes.
 *
 * Deliberately not an `OpenedDocument`. That variant carries the document's own
 * bytes, which the save path patches and writes back; this one carries a parsed
 * *fragment*, because a `.hwpx` has no docx bytes to patch — it is re-encoded
 * from the editor on every save. Modelling them as one type would mean a `data`
 * field that is null for half its values, and a save path that discovers which
 * kind it has at runtime.
 *
 * `ref` is what makes this a document rather than a paste. When the host kept
 * the handle, the file is the document's own: Save writes `.hwpx` over it,
 * through the same conflict detection and recents bookkeeping a `.docx` gets.
 * When it is null, the source cannot be written back — a converted `.hwp`, whose
 * binary format nothing here produces — and the result is an unsaved document
 * that saves as the `.hwpx` it was converted into.
 *
 * The re-encoding is lossy in both directions: the fragment's tag set carries
 * headings, lists, marks and tables and nothing else. That is why `align` rides
 * alongside and `droppedImages` is reported rather than swallowed.
 */
export interface ImportedDocument {
  /**
   * The document body as a restricted HTML fragment: `h1`–`h6`, `p`,
   * `ul`/`ol`/`li`, `strong`/`em`/`u`/`s`, `a`, `br` and tables. The same subset
   * the AI panel's `insert_content` accepts, and parsed by the same code.
   */
  html: string
  /**
   * Paragraph alignment, one entry per top-level block of `html`, because the
   * fragment's tag set has nowhere to carry it. Applied positionally, and only
   * when the length matches the blocks actually parsed.
   */
  align: ReadonlyArray<'center' | 'right' | 'justify' | null>
  /**
   * Pictures the fragment could not carry.
   *
   * Reported rather than swallowed: an import that silently drops the figures
   * out of a report is worse than one that says how many it dropped.
   */
  droppedImages: number
  /** Name of the source file, e.g. `report.hwpx`, for the status message. */
  sourceName: string
  /** What to call the document, e.g. `report.hwpx`. */
  name: string
  /**
   * The file this document saves over, or null when there is none to save over.
   *
   * Non-null for a `.hwpx`, which the host opened through the ordinary picker
   * and can write again. Null for a converted `.hwp`: the conversion is one-way,
   * so writing the result back over the original would replace an HWP 5.0 binary
   * with an OWPML package under a name that lies about its contents.
   */
  ref: DocumentRef | null
  /**
   * What an in-place save encodes. Only `hwpx` today, and named rather than
   * implied so the save path branches on a value instead of on a file extension
   * it re-derives.
   */
  format: 'hwpx'
}

/**
 * What an open request produced.
 *
 * Two outcomes, because the host may have opened a document or converted one.
 * The discriminant exists so the renderer cannot treat the second as the first —
 * see `ImportedDocument`.
 */
export type OpenOutcome =
  { kind: 'document'; document: OpenedDocument } | { kind: 'import'; imported: ImportedDocument }

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
   * Why the write did not happen, when the reason is neither an error nor a
   * cancellation.
   *
   * `external-modified`: the file changed on disk since it was opened. The host has
   * already prompted (or, for an autosave, deferred to the next manual save), so
   * the renderer must not show a second dialog for this reason.
   *
   * `needs-permission`: the host may not write this document without asking the
   * user first, and this write was an autosave — so it declined rather than
   * putting a permission dialog on screen that nobody asked for. Browser-only: a
   * document opened through the File System Access API is granted *read* by the
   * open dialog and write only on a second, separate grant, and a handle restored
   * after a reload starts with neither. Nothing failed and nothing was written; the
   * document stays dirty and the next save the user actually performs asks for the
   * grant with their gesture behind it.
   */
  reason?: 'external-modified' | 'needs-permission'
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
   * a dialog needs a user who asked for one — so a save reached from a timer (the
   * recovery tick, the post-AI-run auto-name) genuinely cannot proceed. Nothing
   * was written and nothing failed. It is what `saveNew`'s `auto` flag resolves
   * to on such a host, and the browser adapter answers it from the flag alone,
   * never from a probe of transient activation.
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
  /**
   * First save of a never-saved document: silent, into the host's default location.
   *
   * `auto` carries the *intent*, and on a host that can only name a document
   * through a dialog it is the difference between a save and an ambush. It is
   * required rather than defaulted because every caller already knows the answer
   * and a forgotten `true` is exactly the bug this parameter exists to prevent:
   * the recovery tick used to reach the browser's Save As dialog every 30
   * seconds. `true` means no user asked for this save, so the host must either
   * write silently or decline with `needs-user-gesture` — never open anything.
   *
   * Transient user activation is deliberately *not* the test a host should use
   * instead. `navigator.userActivation.isActive` stays true for seconds after any
   * keystroke, so a document being actively edited holds activation almost
   * continuously: probing it tells a host that it *may* open a dialog, never that
   * anybody wanted one.
   */
  saveNew(defaultName: string, data: ArrayBuffer, auto: boolean): Promise<SaveNamedDocumentResult>
  /** Crash-recovery copy of a dirty document, kept by the host outside the document itself. */
  writeRecoveryCopy(ref: DocumentRef, data: ArrayBuffer): Promise<{ ok: boolean }>
  /**
   * Does this host keep crash-recovery state at all?
   *
   * Both halves of the renderer's recovery tick are host features: a dirty
   * document with a ref gets `writeRecoveryCopy`, and one that has never been
   * saved is instead named and written silently through `saveNew`. Electron backs
   * both, so it answers `true`. A browser backs neither — there is no host-owned
   * location to write a copy to, and naming a file needs a dialog — so it answers
   * `false` and the renderer skips the tick entirely rather than re-serialising
   * the whole document every 30 seconds to throw the bytes away.
   *
   * A boolean rather than a nullable port because there is no *operation* to hand
   * over: `writeRecoveryCopy` still exists on both hosts (the web one honestly
   * reports `{ ok: false }`), and what the renderer needs to know is whether
   * running its timer is worth anything. Same shape, and the same reasoning, as
   * `DocsWindowPort.nativeChrome`.
   */
  crashRecovery: boolean
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
 * @samugen/platform's ports/window.ts.
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
   * Whether the host draws the window frame and the application menu itself.
   *
   * True under Electron, false in a browser, and it settles two ribbon questions
   * that the operating system alone cannot answer:
   *
   *   - **Where the File menu lives.** Word for Mac has no File *tab*, because
   *     its file commands sit in the macOS menu bar. That is only true when
   *     something is drawing a menu bar; a browser tab on macOS has none, so
   *     keying the decision on the platform string alone hides the File menu and
   *     leaves Open, Save As and Export unreachable.
   *   - **Window-chrome padding.** The tab row reserves space for macOS traffic
   *     lights or the Windows caption-button overlay. A browser draws neither, so
   *     reserving it there is dead space.
   *
   * A plain boolean rather than a port because there is nothing to call: the
   * renderer only asks what kind of window it is in. `IN_TAB` already covers the
   * shell's tab strip, which owns the chrome on the host's behalf.
   */
  nativeChrome: boolean
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

/** Outcome of writing an exported file: `path` is display-only. */
export interface HwpxExportResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * Turning the document into `.hwpx` bytes — to write elsewhere, or to save.
 *
 * Two operations because there are two situations. A `.docx` being exported is a
 * copy in another format, and gets a dialog (`exportDocument`). A `.hwpx` that
 * was *opened* is the document, and its Save writes the file it came from, using
 * the same path a `.docx` save uses — so all that is needed there is the bytes
 * (`convert`).
 *
 * The conversion is lossy in both directions: only what the restricted fragment
 * can carry survives. For an export that is a copy the user asked for, and for a
 * save it is the format the user chose to work in, so both are honest — but it
 * is why opening a `.hwpx` reports what it dropped.
 *
 * Behind the host rather than called directly, because *where* the conversion
 * runs differs: the Electron adapter forwards to the main process, and the web
 * adapter runs @samugen/hwpx-convert in the page and writes through the File
 * System Access API. Both use the same converter, so neither host can produce a
 * different document from the other.
 *
 * Still nullable, for the reason every port here is: so a host that cannot
 * convert says so and the command is not offered. See `DocsPlatform.hwpx`.
 */
export interface DocsHwpxPort {
  /**
   * Convert a restricted HTML fragment to `.hwpx` and let the host write it out.
   *
   * `ok: false` with no `error` is the user dismissing the save dialog, matching
   * the PDF export port's convention.
   */
  exportDocument(defaultName: string, html: string): Promise<HwpxExportResult>
  /**
   * Convert a restricted HTML fragment to `.hwpx` bytes, and write nothing.
   *
   * What makes an open `.hwpx` save like a `.docx` instead of turning into one.
   * The save path needs bytes and already owns everything that happens to them —
   * the ref, the conflict check, the dialog for a document with no ref yet — so
   * the only format-specific step is producing them, and this is it.
   *
   * Throws rather than returning a result: a conversion failure here is the same
   * kind of event as the docx serializer throwing, and `save()` already reports
   * that path.
   */
  convert(html: string): Promise<ArrayBuffer>
}

/** Outcome of handing the document to the user as a download. */
export interface DownloadResult {
  ok: boolean
  /** Name the file was delivered under, for the status message. */
  name?: string
  error?: string
}

/**
 * Handing the document's current bytes to the user as a download.
 *
 * The browser's answer to a question the desktop never has to ask. Electron's
 * Save As writes wherever the user points it and the document keeps editing that
 * file; a page can only do that for a file the user opened through the File
 * System Access API, and it can do nothing at all for a document that has never
 * been saved — a new document, or a `.hwpx` that arrived as an import. Those have
 * no destination, and inventing one every 30 seconds is what made this port
 * necessary.
 *
 * So this is the deliberate opposite of `DocsFilePort.save`: it does not adopt a
 * destination, does not mint a ref, and does not mark the document saved. It
 * copies the bytes out, once, because the user asked. The document stays exactly
 * as dirty as it was — the copy in the downloads folder is not the open document,
 * and the close guard must still warn about the page's unsaved state.
 *
 * `null` on a host that has somewhere better to put a file. Electron leaves it
 * null for that reason: Save and Save As already write the real document, and a
 * "Download" item next to them would offer a worse version of what the desktop
 * app does properly.
 */
export interface DocsDownloadPort {
  /**
   * Deliver `data` to the user under `defaultName`.
   *
   * Resolves `{ ok: true }` once the download has been handed to the browser.
   * Whether the user then keeps the file, renames it or cancels the browser's own
   * save prompt is not observable to a page, and this port does not pretend
   * otherwise — the promise means "handed over", not "on disk".
   */
  download(defaultName: string, data: ArrayBuffer): Promise<DownloadResult>
}

/**
 * docs' composed platform.
 *
 * Seven members are `X | null`, and the nullability is the whole design rather
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
 *   - `search` — Electron: the main process's Serper/DuckDuckGo client, which
 *     also sidesteps renderer CORS. Web: `null`; the search backends need a key
 *     the browser must never hold and an origin its CSP (`connect-src 'self'`)
 *     forbids, so this needs a server route the BFF does not yet have.
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
  search: SearchPort | null
  window: DocsWindowPort
  file: DocsFilePort
  tabs: DocsTabsPort | null
  pdfExport: DocsPdfExportPort | null
  print: DocsPrintPort | null
  /**
   * HWPX export, or `null` on a host that cannot convert.
   *
   * Non-null on both hosts today, which is what separates it from `pdfExport`
   * above. A browser-side PDF exporter would have to re-render the document and
   * would write something *different* from the desktop under one command name;
   * HWPX runs the identical converter in both places, because
   * @samugen/hwpx-convert assembles the package from an embedded template and
   * so needs no filesystem. Electron converts in the main process, the browser
   * in the page.
   *
   * Kept nullable rather than made required so a future host that cannot convert
   * has an honest value to report, and the ribbon hides the command instead of
   * offering a broken one.
   *
   * Import is expressed the other way round: it is folded into `DocsFilePort`'s
   * open calls, so a host that cannot convert simply never returns an `import`
   * outcome.
   */
  hwpx: DocsHwpxPort | null
  /**
   * Copying the document out as a download, or `null` on a host that writes real
   * files instead.
   *
   * The mirror image of `print`: there it is the *browser* that leaves the port
   * null, here it is Electron. A desktop Save As already puts the document
   * wherever the user wants and keeps editing it there, so a download would be a
   * strictly worse duplicate of a command that works. In a browser it is the only
   * way to get a never-saved document out of the page at all, so this is where
   * the command exists — and, being nullable, it exists exactly there.
   */
  download: DocsDownloadPort | null
}

/**
 * What a host module must export as `createDocsPlatform`.
 *
 * This is the build-time seam. `main.tsx` imports `createDocsPlatform` from the
 * bare specifier `@host`, which the Vite config and tsconfig both resolve to
 * `host-web.ts`, so the entry point names no host and carries no runtime check for
 * one. Async because the host has to open IndexedDB before it can resolve a
 * `DocumentRef`.
 */
export type CreateDocsPlatform = () => Promise<DocsPlatform>

export const { set: setDocsPlatform, get: docsPlatform } = createPlatformSlot<DocsPlatform>('docs')
