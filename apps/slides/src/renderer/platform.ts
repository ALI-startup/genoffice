/**
 * slides' platform slot: the one place the renderer names the host capabilities it needs, and the
 * only thing renderer code is allowed to reach the host through.
 */
import { createPlatformSlot, type AttachmentsPort } from '@samugen/platform'
import type { ProjectApi } from '@samugen/project-store'
import type { SlidesApi } from '../shared/ipc'

/**
 * Every document operation and query: edits, inserts, deletes, undo/redo, tables, master view,
 * sections, animations, notes, comments, and the RenderSlide rebuilds they return.
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
 * Getting a deck in and out, and the host pickers that insert media into one: the open dialog,
 * save, Save As, the document a new tab was created with, the recent list, and picture/media/model
 * insertion.
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

/** The in-app clipboard: a slide or a set of elements copied here and pasted back here. */
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
 * The close-guard handshake, the dirty flag, and the host reporting that the open document was
 * replaced or renamed underneath the renderer.
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

/** The UI language: the current one, switching it, and every other editor hearing about it. */
export type SlidesLanguagePort = Pick<
  SlidesApi,
  'getLanguage' | 'onLanguageChanged' | 'setLanguage'
>

/**
 * The AI surface: provider settings, the streaming channel and its chunks, snapshot rollback, and
 * the two multimodal helpers.
 */
export type SlidesAiPort = Pick<
  SlidesApi,
  'aiSnapshotRestore' | 'aiStream' | 'aiStreamCancel' | 'getAiSettings' | 'onAiStream'
>

/** Printing the deck — slides, handouts or notes pages. */
export type SlidesPrintPort = Pick<SlidesApi, 'printSlides'>

/** Image generation and media analysis. */
export type SlidesAiMediaPort = Pick<SlidesApi, 'generateImage'>

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

/** Web and image search behind the AI tools. */
export type SlidesSearchPort = Pick<SlidesApi, 'imageSearch' | 'webSearch'>

/** The style templates the AI can generate against, read from the host's own files. */
export type SlidesStyleTemplatePort = Pick<
  SlidesApi,
  'listStyleTemplates' | 'loadStyleTemplate' | 'saveStyleSidecar' | 'saveStyleTemplate'
>

/** Commands from the native application menu. */
export type SlidesMenuPort = Pick<SlidesApi, 'onMenuCommand'>

/** The attachment surface the AI panel uses. */
export type SlidesAttachmentsPort = AttachmentsPort

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
  search: SlidesSearchPort | null
  styleTemplates: SlidesStyleTemplatePort | null
  menu: SlidesMenuPort | null
}

/** What a host module must export as `createSlidesPlatform`. */
export type CreateSlidesPlatform = () => Promise<SlidesPlatform>

export const { set: setSlidesPlatform, get: slidesPlatform } =
  createPlatformSlot<SlidesPlatform>('slides')

// Per-port accessors for the required ports, so a call site reads `slidesDoc().editText(op)` rather
// than `slidesPlatform().doc.editText(op)`.
export const slidesDoc = (): SlidesDocumentPort => slidesPlatform().doc
export const slidesFile = (): SlidesFilePort => slidesPlatform().file
export const slidesDeckClipboard = (): SlidesDeckClipboardPort => slidesPlatform().deckClipboard
export const slidesWindow = (): SlidesWindowPort => slidesPlatform().window
export const slidesLanguage = (): SlidesLanguagePort => slidesPlatform().language
export const slidesAi = (): SlidesAiPort => slidesPlatform().ai
export const slidesPrint = (): SlidesPrintPort => slidesPlatform().print
export const slidesAttachments = (): SlidesAttachmentsPort => slidesPlatform().attachments
