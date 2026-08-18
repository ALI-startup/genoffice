/**
 * slides' platform slot: the one place the renderer names the host capabilities it needs,
 * and the only thing renderer code is allowed to reach the host through.
 *
 * The same arrangement docs and pdf have, arrived at differently. Those two declared their
 * ports from scratch; slides already had one typed object describing its whole host
 * surface — `SlidesApi` in ../shared/ipc.ts, 148 members, which the renderer reached as
 * `window.slidesApi`. So the ports here are `Pick`s of it: nothing is retyped, the split is
 * visible in one place, and the Electron adapter satisfies every port with the same bridge
 * object it always used.
 *
 * The split is the design. Eight ports are required and a web host must answer all of
 * them; seven are `X | null`, and each of those is a capability a browser genuinely cannot
 * back — not a stub, and not an optional method:
 *
 *   - `aiMedia` — image generation and media analysis, which call a provider directly with a
 *     credential the browser must never hold and have no BFF route.
 *   - `presenter` — a second window mirrored to a projector, plus its ink channel.
 *   - `pdfExport` — the main process renders with `printToPDF` and merges with pdf-lib. The
 *     same decision docs made in Phase 4c: a renderer-side exporter would write a
 *     *different* document under one command name, so the browser prints instead.
 *   - `clipboard` — reading what another application put on the system clipboard. The
 *     in-app deck clipboard is a separate, required port; see `SlidesDeckClipboardPort`.
 *   - `genspark` — sign-in shells out to the `gsk` CLI, a local process.
 *   - `search` — needs a key the browser must never hold and an origin its CSP forbids, so
 *     it needs a BFF route that does not exist yet.
 *   - `cloud` — server-side generation, gated on the same account plumbing.
 *   - `styleTemplates` — read off the host's filesystem today.
 *   - `menu` — the native application menu; a page has no menu bar.
 *
 * That eight of the fifteen are required — including all 84 document operations — is what
 * phase 7a bought. Before it, `doc` was a main-process surface and a browser could only
 * have faked it.
 */
import { createPlatformSlot } from '@genoffice/platform'
import type { ProjectApi } from '@genoffice/project-store'
import type { DesktopFilesApi, SlidesApi } from '../shared/ipc'

/**
 * Every document operation and query: edits, inserts, deletes, undo/redo, tables, master
 * view, sections, animations, notes, comments, and the RenderSlide rebuilds they return.
 *
 * Required on both hosts, because the implementation is the same code either way —
 * src/domain/ops.ts. All 84 members map one-to-one onto an operation there (six by a
 * spelling difference the adapters absorb), so a browser backs this port by calling those
 * functions in the page rather than by reimplementing anything.
 */
export type SlidesDocumentPort = Pick<
  SlidesApi,
  | 'addBlankSlide'
  | 'addChart'
  | 'addComment'
  | 'addElement'
  | 'addImageBytes'
  | 'addInk'
  | 'addMediaBytes'
  | 'addSection'
  | 'addSlide'
  | 'addSlideWithLayout'
  | 'addSmartArt'
  | 'addTable'
  | 'applyHeaderFooter'
  | 'applyTheme'
  | 'batchEditTransform'
  | 'beginHistoryBatch'
  | 'deleteComment'
  | 'deleteElement'
  | 'deleteSlide'
  | 'duplicateElements'
  | 'editBackground'
  | 'editChart'
  | 'editConnectorEndpoints'
  | 'editFill'
  | 'editPictureOpacity'
  | 'editPictureSrcRect'
  | 'editStroke'
  | 'editTableCell'
  | 'editTableStyle'
  | 'editText'
  | 'editTransform'
  | 'endHistoryBatch'
  | 'findReplace'
  | 'flipElements'
  | 'getAnimations'
  | 'getChartColorSchemes'
  | 'getChartData'
  | 'getComments'
  | 'getHeaderFooter'
  | 'getLayouts'
  | 'getLink'
  | 'getMediaData'
  | 'getNotes'
  | 'getRenderSlides'
  | 'getRunLinks'
  | 'getSections'
  | 'getShapeKeys'
  | 'getSlideLinks'
  | 'getSlideSize'
  | 'getTransition'
  | 'groupElements'
  | 'masterClose'
  | 'masterDeleteElement'
  | 'masterEditFill'
  | 'masterEditStroke'
  | 'masterEditText'
  | 'masterEditTransform'
  | 'masterEnter'
  | 'masterOpen'
  | 'moveSection'
  | 'moveSlide'
  | 'redo'
  | 'removeSection'
  | 'renameSection'
  | 'reorderElement'
  | 'setAdvanceTimes'
  | 'setAnimations'
  | 'setElementFont'
  | 'setElementParagraphFormat'
  | 'setLink'
  | 'setNotes'
  | 'setSections'
  | 'setSlideHidden'
  | 'setSlideLayout'
  | 'setSlideSize'
  | 'setTableCellAnchor'
  | 'setTableColWidth'
  | 'setTableRowHeight'
  | 'setTextAnchor'
  | 'setTransition'
  | 'tableMerge'
  | 'tableStructure'
  | 'undo'
  | 'ungroupElement'
>

/**
 * Getting a deck in and out, and the host pickers that insert media into one: the open
 * dialog, save, Save As, the document a new tab was created with, the recent list, and
 * picture/media/model insertion.
 *
 * Required on both hosts, implemented differently on each — native dialogs and a path, or
 * the File System Access API and an opaque handle. Nothing here carries a path, so the
 * renderer cannot come to depend on one.
 */
export type SlidesFilePort = Pick<
  SlidesApi,
  | 'consumePendingOpen'
  | 'editImageFill'
  | 'getRecentFiles'
  | 'insertImage'
  | 'insertImageUrl'
  | 'insertMedia'
  | 'insertModel3d'
  | 'newBlank'
  | 'openPptx'
  | 'openPptxPath'
  | 'save'
  | 'saveAs'
>

/**
 * The in-app clipboard: a slide or a set of elements copied here and pasted back here.
 *
 * Separate from `clipboard` below, and required rather than nullable, because this is not
 * the system clipboard. Electron keeps the copied slide per renderer in the main process
 * so it can cross two windows; a browser keeps it per page, which is a narrower promise
 * but a real one. The native clipboard — reading what another application put there — is
 * the nullable port.
 */
export type SlidesDeckClipboardPort = Pick<
  SlidesApi,
  | 'copyElements'
  | 'copySlide'
  | 'hasSlideClipboard'
  | 'pasteElements'
  | 'pasteSlide'
  | 'repasteSlide'
>

/**
 * The close-guard handshake, the dirty flag, and the host reporting that the open document
 * was replaced or renamed underneath the renderer.
 *
 * A pull, not a push: the host asks at close time and the renderer answers, which is the
 * one shape `beforeunload` can also express.
 */
export type SlidesWindowPort = Pick<
  SlidesApi,
  | 'isDirty'
  | 'onCloseSaveRequest'
  | 'onOpened'
  | 'onRenamed'
  | 'reportCloseSaveResult'
  | 'setAutoSavePref'
>

/** The UI language, and the shell telling every editor that the user changed it. */
export type SlidesLanguagePort = Pick<SlidesApi, 'getLanguage' | 'onLanguageChanged'>

/**
 * The AI surface: provider settings, the streaming channel and its chunks, snapshot
 * rollback, and the two multimodal helpers.
 *
 * Required on both. Electron streams from the main process; a browser streams from the
 * BFF, which is the only place a provider credential may live — and where settings are
 * therefore read-only (see §6.2 of the migration doc).
 */
export type SlidesAiPort = Pick<
  SlidesApi,
  'aiSnapshotRestore' | 'aiStream' | 'aiStreamCancel' | 'getAiSettings' | 'onAiStream'
>

/**
 * Printing the deck — slides, handouts or notes pages.
 *
 * Required on both, and the only member where Electron is the one doing something
 * unusual: it renders the print HTML in a hidden window because the renderer's own page is
 * the editor, not the printout. A browser prints that same HTML from a frame.
 */
export type SlidesPrintPort = Pick<SlidesApi, 'printSlides'>

/**
 * Image generation and media analysis.
 *
 * Separate from `ai` because the BFF has no route for either: both call a provider directly
 * with a credential the browser must never hold. The streaming channel above has a route and
 * so stays required.
 */
export type SlidesAiMediaPort = Pick<SlidesApi, 'analyzeMedia' | 'generateImage'>

/** Presenter view, the audience window, and the ink and sync channels between them. */
export type SlidesPresenterPort = Pick<
  SlidesApi,
  | 'audienceNav'
  | 'audienceReady'
  | 'onAudienceNav'
  | 'onShowInk'
  | 'onShowSync'
  | 'presenterEnd'
  | 'presenterInk'
  | 'presenterStart'
  | 'presenterSwap'
  | 'presenterSync'
>

/** PDF and image export, both of which render outside the renderer. */
export type SlidesPdfExportPort = Pick<
  SlidesApi,
  'exportImages' | 'exportPdf' | 'pickExportDir' | 'pickExportPdfPath'
>

/** The *system* clipboard: images and text arriving from other applications. */
export type SlidesClipboardPort = Pick<SlidesApi, 'clipboardExternal' | 'nativeClipboard'>

/** Genspark sign-in status and the sign-in flow itself. */
export type SlidesGensparkPort = Pick<SlidesApi, 'aiGskLogin' | 'aiGskStatus' | 'gskStatus'>

/** Web and image search behind the AI tools. */
export type SlidesSearchPort = Pick<SlidesApi, 'imageSearch' | 'webSearch'>

/** Server-side deck generation, and landing the pages it returns. */
export type SlidesCloudPort = Pick<SlidesApi, 'cloudGenStatus' | 'cloudGeneratePage' | 'htmlToPptx'>

/** The style templates the AI can generate against, read from the host's own files. */
export type SlidesStyleTemplatePort = Pick<
  SlidesApi,
  'listStyleTemplates' | 'loadStyleTemplate' | 'saveStyleSidecar' | 'saveStyleTemplate'
>

/** Commands from the native application menu. */
export type SlidesMenuPort = Pick<SlidesApi, 'onMenuCommand'>

/**
 * The attachment surface the AI panel uses, which slides reaches through `window.desktop`
 * rather than `window.slidesApi`.
 *
 * Still path-based here, unlike docs' `AttachmentsPort`, which became ref-based in Phase
 * 4a. Collapsing the two is §6.3 of the migration doc and is the next thing to do on this
 * port; until then a web host has to mint something a path-shaped field can carry.
 */
export type SlidesAttachmentsPort = Pick<
  DesktopFilesApi,
  | 'addAttachmentPaths'
  | 'addPastedImage'
  | 'getPathForFile'
  | 'pickAttachments'
  | 'readAttachment'
  | 'readAttachmentImage'
>

/** slides' composed platform. */
export interface SlidesPlatform {
  doc: SlidesDocumentPort
  file: SlidesFilePort
  deckClipboard: SlidesDeckClipboardPort
  window: SlidesWindowPort
  language: SlidesLanguagePort
  ai: SlidesAiPort
  print: SlidesPrintPort
  attachments: SlidesAttachmentsPort
  /** Chat/project history, or `null` on a host with no store behind it (§6.1). */
  project: ProjectApi | null
  presenter: SlidesPresenterPort | null
  aiMedia: SlidesAiMediaPort | null
  pdfExport: SlidesPdfExportPort | null
  clipboard: SlidesClipboardPort | null
  genspark: SlidesGensparkPort | null
  search: SlidesSearchPort | null
  cloud: SlidesCloudPort | null
  styleTemplates: SlidesStyleTemplatePort | null
  menu: SlidesMenuPort | null
}

/**
 * What a host module must export as `createSlidesPlatform`.
 *
 * The build-time seam: `main.tsx` imports it from the bare specifier `@host`, which each
 * Vite config aliases to exactly one host, so the Electron bundle carries no browser code
 * and a web bundle no reference to `window.slidesApi`.
 */
export type CreateSlidesPlatform = () => Promise<SlidesPlatform>

export const { set: setSlidesPlatform, get: slidesPlatform } =
  createPlatformSlot<SlidesPlatform>('slides')

// Per-port accessors for the required ports, so a call site reads `slidesDoc().editText(op)`
// rather than `slidesPlatform().doc.editText(op)`. The nullable ports deliberately have
// none: their callers must hold the port and test it, which is the point of the null.
export const slidesDoc = (): SlidesDocumentPort => slidesPlatform().doc
export const slidesFile = (): SlidesFilePort => slidesPlatform().file
export const slidesDeckClipboard = (): SlidesDeckClipboardPort => slidesPlatform().deckClipboard
export const slidesWindow = (): SlidesWindowPort => slidesPlatform().window
export const slidesLanguage = (): SlidesLanguagePort => slidesPlatform().language
export const slidesAi = (): SlidesAiPort => slidesPlatform().ai
export const slidesPrint = (): SlidesPrintPort => slidesPlatform().print
export const slidesAttachments = (): SlidesAttachmentsPort => slidesPlatform().attachments
