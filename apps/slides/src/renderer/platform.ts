/**
 * slides' platform slot: the one place the renderer names the host capabilities it
 * needs, and the only thing renderer code is allowed to reach the host through.
 *
 * The same arrangement docs and pdf already have, arrived at differently. Those two
 * declared their ports from scratch; slides already had one typed object describing
 * its whole host surface — `SlidesApi` in ../shared/ipc.ts, 148 members, which the
 * renderer reached as `window.slidesApi`. So the ports here are `Pick`s of it. Nothing
 * is retyped, the split is visible in one place, and the Electron adapter satisfies
 * every port with the same bridge object it always used.
 *
 * The split itself is the design. Five of these are `X | null`, and each one is a
 * capability a browser genuinely cannot back — not a stub, not an optional method:
 *
 *   - `presenter` — a second window, mirrored to a projector, plus its ink channel.
 *     A page cannot open one. (8 members)
 *   - `pdfExport` — the main process renders with `printToPDF` and merges with pdf-lib.
 *     The same decision docs made in Phase 4c: a renderer-side exporter would write a
 *     *different* document under the same command name, so the browser prints instead.
 *   - `clipboard` — the native clipboard, which is how a slide crosses between two decks
 *     in two windows, and how images arrive from other applications. A page gets the
 *     async Clipboard API and no cross-window deck clipboard at all.
 *   - `genspark` — sign-in shells out to the `gsk` CLI, a local process.
 *   - `search` — the AI's web/image search needs a key the browser must never hold and
 *     an origin its CSP forbids; it needs a BFF route that does not exist yet.
 *   - `cloud` — server-side deck generation, gated on the same account plumbing.
 *   - `menu` — the native application menu sends commands; a page has no menu bar.
 *
 * Everything else is required, and a web host has to answer all of it. That is what
 * phase 7a bought: `doc`'s 104 members are the operations in src/domain/ops.ts, which
 * run in a page as happily as in the main process, so this is not a surface a browser
 * has to fake.
 */
import { createPlatformSlot } from '@genoffice/platform'
import type { ProjectApi } from '@genoffice/project-store'
import type { SlidesApi } from '../shared/ipc'
import type { DesktopFilesApi } from '../shared/ipc'

/**
 * Every document operation and query: edits, inserts, deletes, undo/redo, tables,
 * master view, sections, animations, notes, comments, and the RenderSlide rebuilds
 * they return.
 *
 * Backed identically by both hosts, because the implementation is the same code —
 * src/domain/ops.ts. Electron reaches it over IPC because the session lives in the
 * main process; a browser calls it in the page. Same functions, same results.
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
  | 'analyzeMedia'
  | 'applyHeaderFooter'
  | 'applyTheme'
  | 'batchEditTransform'
  | 'beginHistoryBatch'
  | 'copyElements'
  | 'copySlide'
  | 'deleteComment'
  | 'deleteElement'
  | 'deleteSlide'
  | 'duplicateElements'
  | 'editBackground'
  | 'editChart'
  | 'editConnectorEndpoints'
  | 'editFill'
  | 'editImageFill'
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
  | 'generateImage'
  | 'getAiSettings'
  | 'getAnimations'
  | 'getChartColorSchemes'
  | 'getChartData'
  | 'getComments'
  | 'getHeaderFooter'
  | 'getLayouts'
  | 'getLink'
  | 'getMediaData'
  | 'getNotes'
  | 'getRecentFiles'
  | 'getRenderSlides'
  | 'getRunLinks'
  | 'getSections'
  | 'getShapeKeys'
  | 'getSlideLinks'
  | 'getSlideSize'
  | 'getTransition'
  | 'groupElements'
  | 'gskStatus'
  | 'htmlToPptx'
  | 'insertMedia'
  | 'listStyleTemplates'
  | 'loadStyleTemplate'
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
  | 'onAiStream'
  | 'onShowInk'
  | 'onShowSync'
  | 'pasteElements'
  | 'pasteSlide'
  | 'printSlides'
  | 'redo'
  | 'removeSection'
  | 'renameSection'
  | 'reorderElement'
  | 'repasteSlide'
  | 'setAdvanceTimes'
  | 'setAiSettings'
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
 * Getting a deck in and out: the open dialog, save, Save As, the pending document a
 * new tab was created with, and the media pickers that insert a picture or a model.
 *
 * Required on both hosts and implemented differently on each — native dialogs and a
 * path, or the File System Access API and an opaque handle. The renderer must not care
 * which, which is why nothing here carries a path.
 */
export type SlidesFilePort = Pick<
  SlidesApi,
  | 'consumePendingOpen'
  | 'insertImage'
  | 'insertImageUrl'
  | 'insertModel3d'
  | 'newBlank'
  | 'openPptx'
  | 'openPptxPath'
  | 'save'
  | 'saveAs'
  | 'saveStyleSidecar'
  | 'saveStyleTemplate'
>

/**
 * The close-guard handshake, the dirty flag, and the host telling the renderer that the
 * document it holds was opened or renamed underneath it.
 *
 * A pull, not a push: the host asks at close time and the renderer answers, which is the
 * one shape `beforeunload` can also express. See docs' `DocsWindowPort` for the same
 * reasoning at length.
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
 * The AI panel's streaming channel and its snapshot rollback.
 *
 * Required on both: Electron streams from the main process, a browser streams from the
 * BFF (which is the only place a provider credential may live). The wire contract is
 * shared, so neither side can drift.
 */
export type SlidesAiPort = Pick<SlidesApi, 'aiSnapshotRestore' | 'aiStream' | 'aiStreamCancel'>

/** Presenter view, the audience window, and the ink channel between them. */
export type SlidesPresenterPort = Pick<
  SlidesApi,
  | 'audienceNav'
  | 'audienceReady'
  | 'onAudienceNav'
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

/** The native clipboard: slides crossing decks, and images arriving from other apps. */
export type SlidesClipboardPort = Pick<
  SlidesApi,
  'clipboardExternal' | 'hasSlideClipboard' | 'nativeClipboard'
>

/** Genspark sign-in status and the sign-in flow itself. */
export type SlidesGensparkPort = Pick<SlidesApi, 'aiGskLogin' | 'aiGskStatus'>

/** Web and image search behind the AI tools. */
export type SlidesSearchPort = Pick<SlidesApi, 'imageSearch' | 'webSearch'>

/** Server-side deck generation. */
export type SlidesCloudPort = Pick<SlidesApi, 'cloudGenStatus' | 'cloudGeneratePage'>

/** Commands from the native application menu. */
export type SlidesMenuPort = Pick<SlidesApi, 'onMenuCommand'>

/**
 * The attachment surface the AI panel uses, which slides reaches through `window.desktop`
 * rather than `window.slidesApi`.
 *
 * Ref-based on both hosts since docs' Phase 4a — see @genoffice/platform's
 * `AttachmentsPort` for why a path cannot cross this seam.
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
  window: SlidesWindowPort
  language: SlidesLanguagePort
  ai: SlidesAiPort
  attachments: SlidesAttachmentsPort
  /** Chat/project history, or `null` on a host with no store behind it (see §6.1 of the migration doc). */
  project: ProjectApi | null
  presenter: SlidesPresenterPort | null
  pdfExport: SlidesPdfExportPort | null
  clipboard: SlidesClipboardPort | null
  genspark: SlidesGensparkPort | null
  search: SlidesSearchPort | null
  cloud: SlidesCloudPort | null
  menu: SlidesMenuPort | null
}

/**
 * What a host module must export as `createSlidesPlatform`.
 *
 * The build-time seam: `main.tsx` imports it from the bare specifier `@host`, which each
 * Vite config aliases to exactly one host, so the Electron bundle carries no browser
 * code and a web bundle no reference to `window.slidesApi`.
 */
export type CreateSlidesPlatform = () => Promise<SlidesPlatform>

export const { set: setSlidesPlatform, get: slidesPlatform } =
  createPlatformSlot<SlidesPlatform>('slides')

// Per-port accessors, so a call site reads `slidesDoc().editText(op)` rather than
// `slidesPlatform().doc.editText(op)`. The nullable ports deliberately have none: their
// callers must hold the port and test it, which is the whole point of the null.
export const slidesDoc = (): SlidesDocumentPort => slidesPlatform().doc
export const slidesFile = (): SlidesFilePort => slidesPlatform().file
export const slidesWindow = (): SlidesWindowPort => slidesPlatform().window
export const slidesLanguage = (): SlidesLanguagePort => slidesPlatform().language
export const slidesAi = (): SlidesAiPort => slidesPlatform().ai
export const slidesAttachments = (): SlidesAttachmentsPort => slidesPlatform().attachments
