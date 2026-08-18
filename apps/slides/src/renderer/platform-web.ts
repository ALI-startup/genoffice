/**
 * Builds slides' platform for a browser.
 *
 * The mirror of platform-electron.ts, and the shape of the two says what phase 7a bought.
 * The Electron adapter forwards every port to a preload bridge, because the document lives
 * in the main process. Here there is no bridge and no other process: the document lives in
 * this page, and the `doc` port's 84 members are direct calls into src/domain/ops.ts — the
 * same functions the main process runs, with the same session shape.
 *
 * That makes this host *faster* than the desktop one for every edit, not slower: an edit is
 * a function call rather than a structured-clone round trip through IPC. The logic is
 * identical because it is literally the same code.
 *
 * Nothing in this file reaches a browser global. The document store, the pickers, the font
 * metrics and the host services are all passed in, so this module is exercisable without a
 * `window`, and host-web.ts is the only place globals are read — the same division docs
 * and pdf use.
 */
import type { OpenedPptx } from '@genoffice/pptx-engine'
import type { Session } from '../domain/session'
import {
  slideOps,
  type DeckClipboardStore,
  type ElementClipboardEntry,
  type LastSlidePaste,
  type OpsTranslate,
  type SlideClipboardEntry,
} from '../domain/ops'
import type { SlidesDeckClipboardPort, SlidesDocumentPort } from './platform'

/**
 * The one deck this page has open, and the session every operation acts on.
 *
 * Electron keys sessions by `webContents.id` because one process serves several editors.
 * A page is one editor, so this is a single slot — which is why `slideOps`' first parameter
 * is `Session | undefined`: the guards that fire on the desktop when a renderer has no
 * session are simply never taken here, and the code path is otherwise the same.
 */
export class WebSlidesSession {
  private current: Session | undefined

  /** The session, or `undefined` before a deck has been opened. */
  get(): Session | undefined {
    return this.current
  }

  /** Adopt a freshly opened deck. `ref` is the store's opaque handle key, not a path. */
  open(ref: string, opened: OpenedPptx, fitWidthPx: number): Session {
    this.current = { path: ref, opened, fitWidthPx, undoStack: [], redoStack: [] }
    return this.current
  }

  /** Replace the session's document wholesale (AI replacing the deck, a new blank one). */
  replace(session: Session): void {
    this.current = session
  }
}

/** The host services the document port cannot answer for itself. */
export interface WebDocumentServices {
  /**
   * The author name new comments are attributed to. `userInfo().username` on the desktop; a
   * browser has no equivalent, so the host decides what to put there.
   */
  commentAuthor: () => string
  /** The host's translations for the labels two operations hand to the user. */
  translate: OpsTranslate
  /**
   * Ask the user to confirm rebuilding an imported chart. `window.confirm` on this host —
   * the closest a page gets to the desktop's native warning box, and the same substitution
   * docs makes for its overwrite prompt.
   */
  confirmChartSimplify: () => Promise<boolean>
}

/**
 * The document port, backed by the operations in src/domain/ops.ts.
 *
 * Every member is `async` because the port is one the Electron host answers over IPC, and
 * a promise is the shape the renderer already awaits. Here the work is synchronous and the
 * promise resolves immediately.
 */
export function createWebSlidesDocPort(
  session: () => Session | undefined,
  services: WebDocumentServices,
): SlidesDocumentPort {
  return {
    addBlankSlide: async (op) => slideOps.addBlankSlide(session(), op),
    addChart: async (op) => slideOps.addChart(session(), op),
    // addComment: needs a host service; written by hand below.
    addElement: async (op) => slideOps.addElement(session(), op),
    addImageBytes: async (op) => slideOps.addImageBytes(session(), op),
    addInk: async (op) => slideOps.addInk(session(), op),
    addMediaBytes: async (op) => slideOps.addMediaBytes(session(), op),
    addSection: async (op) => slideOps.addSection(session(), op),
    addSlide: async (op) => slideOps.addSlide(session(), op),
    addSlideWithLayout: async (op) => slideOps.addSlideWithLayout(session(), op),
    addSmartArt: async (op) => slideOps.addSmartart(session(), op),
    addTable: async (op) => slideOps.addTable(session(), op),
    applyHeaderFooter: async (op) => slideOps.applyHeaderFooter(session(), op),
    applyTheme: async (op) => slideOps.applyTheme(session(), op),
    batchEditTransform: async (op) => slideOps.batchEditTransform(session(), op),
    beginHistoryBatch: async () => slideOps.historyBatchBegin(session()),
    deleteComment: async (op) => slideOps.deleteComment(session(), op),
    deleteElement: async (op) => slideOps.deleteElement(session(), op),
    deleteSlide: async (slideIndex) => slideOps.deleteSlide(session(), slideIndex),
    duplicateElements: async (op) => slideOps.duplicateElements(session(), op),
    editBackground: async (op) => slideOps.editBackground(session(), op),
    // editChart: needs a host service; written by hand below.
    editConnectorEndpoints: async (op) => slideOps.editConnectorEndpoints(session(), op),
    editFill: async (op) => slideOps.editFill(session(), op),
    editPictureOpacity: async (op) => slideOps.editPictureOpacity(session(), op),
    editPictureSrcRect: async (op) => slideOps.editPictureSrcRect(session(), op),
    editStroke: async (op) => slideOps.editStroke(session(), op),
    editTableCell: async (op) => slideOps.editTableCell(session(), op),
    editTableStyle: async (op) => slideOps.editTableStyle(session(), op),
    editText: async (op) => slideOps.editText(session(), op),
    editTransform: async (op) => slideOps.editTransform(session(), op),
    endHistoryBatch: async () => slideOps.historyBatchEnd(session()),
    findReplace: async (op) => slideOps.findReplace(session(), op),
    flipElements: async (op) => slideOps.flipElements(session(), op),
    // getAnimations: needs a host service; written by hand below.
    // getChartColorSchemes: needs a host service; written by hand below.
    getChartData: async (slideIndex, sourceId) =>
      slideOps.getChartData(session(), slideIndex, sourceId),
    getComments: async (slideIndex) => slideOps.getComments(session(), slideIndex),
    getHeaderFooter: async (slideIndex) => slideOps.getHeaderFooter(session(), slideIndex),
    getLayouts: async () => slideOps.getLayouts(session()),
    getLink: async (slideIndex, sourceId) => slideOps.getLink(session(), slideIndex, sourceId),
    getMediaData: async (slideIndex, sourceId) =>
      slideOps.mediaData(session(), slideIndex, sourceId),
    getNotes: async (slideIndex) => slideOps.getNotes(session(), slideIndex),
    getRenderSlides: async () => slideOps.getRenderSlides(session()),
    getRunLinks: async (slideIndex) => slideOps.getRunLinks(session(), slideIndex),
    getSections: async () => slideOps.getSections(session()),
    getShapeKeys: async (slideIndex) => slideOps.getShapeKeys(session(), slideIndex),
    getSlideLinks: async (slideIndex) => slideOps.getSlideLinks(session(), slideIndex),
    getSlideSize: async () => slideOps.getSlideSize(session()),
    getTransition: async (slideIndex) => slideOps.getTransition(session(), slideIndex),
    groupElements: async (op) => slideOps.groupElements(session(), op),
    masterClose: async () => slideOps.masterClose(session()),
    masterDeleteElement: async (op) => slideOps.masterDeleteElement(session(), op),
    masterEditFill: async (op) => slideOps.masterEditFill(session(), op),
    masterEditStroke: async (op) => slideOps.masterEditStroke(session(), op),
    masterEditText: async (op) => slideOps.masterEditText(session(), op),
    masterEditTransform: async (op) => slideOps.masterEditTransform(session(), op),
    masterEnter: async (fitWidthPx) => slideOps.masterEnter(session(), fitWidthPx),
    masterOpen: async (partPath) => slideOps.masterOpen(session(), partPath),
    moveSection: async (op) => slideOps.moveSection(session(), op),
    moveSlide: async (op) => slideOps.moveSlide(session(), op),
    redo: async () => slideOps.redo(session()),
    removeSection: async (op) => slideOps.removeSection(session(), op),
    renameSection: async (op) => slideOps.renameSection(session(), op),
    reorderElement: async (op) => slideOps.reorderElement(session(), op),
    setAdvanceTimes: async (op) => slideOps.setAdvanceTimes(session(), op),
    setAnimations: async (op) => slideOps.setAnimations(session(), op),
    setElementFont: async (op) => slideOps.setElementFont(session(), op),
    setElementParagraphFormat: async (op) => slideOps.setElementParagraphFormat(session(), op),
    setLink: async (op) => slideOps.setLink(session(), op),
    setNotes: async (op) => slideOps.setNotes(session(), op),
    setSections: async (sections) => slideOps.setSections(session(), sections),
    setSlideHidden: async (op) => slideOps.setHidden(session(), op),
    setSlideLayout: async (op) => slideOps.setSlideLayout(session(), op),
    setSlideSize: async (op) => slideOps.setSlideSize(session(), op),
    setTableCellAnchor: async (op) => slideOps.setTableCellAnchor(session(), op),
    setTableColWidth: async (op) => slideOps.setTableColWidth(session(), op),
    setTableRowHeight: async (op) => slideOps.setTableRowHeight(session(), op),
    setTextAnchor: async (op) => slideOps.setTextAnchor(session(), op),
    setTransition: async (op) => slideOps.setTransition(session(), op),
    tableMerge: async (op) => slideOps.tableMerge(session(), op),
    tableStructure: async (op) => slideOps.tableStructure(session(), op),
    undo: async () => slideOps.undo(session()),
    ungroupElement: async (op) => slideOps.ungroupElement(session(), op),
    // The four that need a host service. Each takes it as a parameter rather than importing
    // one, which is what keeps src/domain free of i18n, node:os and any dialog.
    addComment: async (op) => slideOps.addComment(session(), op, services.commentAuthor),
    getAnimations: async (slideIndex) =>
      slideOps.getAnimations(session(), slideIndex, services.translate),
    getChartColorSchemes: async () => slideOps.chartColorSchemes(session(), services.translate),
    editChart: async (op) =>
      slideOps.editChart(session(), op, services.confirmChartSimplify, services.translate),
  }
}

/**
 * The in-app deck clipboard, kept in this page.
 *
 * The narrower half of what Electron promises, and honestly so. There the copied slide
 * lives in the main process, so it can be pasted into a deck open in another window; here
 * it lives in the page, so it crosses slides within this deck and no further. That is a
 * real capability rather than a stub, which is why this port is required while reading the
 * *system* clipboard is a nullable one.
 *
 * `markCopied` does nothing here: the desktop writes a marker to the system clipboard so a
 * later paste can tell whether this app or another application copied most recently, and a
 * page that cannot read the system clipboard has no such question to answer.
 */
export function createWebSlidesDeckClipboardPort(
  session: () => Session | undefined,
): SlidesDeckClipboardPort {
  let slide: SlideClipboardEntry | null = null
  let elements: ElementClipboardEntry | null = null
  let lastPaste: LastSlidePaste | null = null
  const store: DeckClipboardStore = {
    slide: () => slide,
    setSlide: (entry) => {
      slide = entry
    },
    elements: () => elements,
    setElements: (entry) => {
      elements = entry
    },
    lastPaste: () => lastPaste,
    setLastPaste: (record) => {
      lastPaste = record
    },
    markCopied: () => {},
  }
  return {
    copySlide: async (slideIndex, pngBase64) =>
      slideOps.copySlide(session(), slideIndex, pngBase64, store),
    hasSlideClipboard: async () => slide !== null,
    pasteSlide: async (op) => slideOps.pasteSlide(session(), op, store),
    repasteSlide: async (op) => slideOps.repasteSlide(session(), op, store),
    copyElements: async (op) => slideOps.copyElements(session(), op, store),
    pasteElements: async (op) => slideOps.pasteElements(session(), op, store),
  }
}
