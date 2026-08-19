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
import {
  commitSaved,
  createBlankPptx,
  openPptx,
  savePptx,
  bytesToBase64,
  type OpenedPptx,
} from '@samugen/pptx-engine'
import type { AiPort, AttachmentsPort, LanguagePort } from '@samugen/platform'
import {
  createWebUnloadPrompt,
  ensurePermission,
  isPickerCancel,
  type FilePickerAcceptType,
  type FilePickers,
  type FrameChildLink,
  type WebDocumentStore,
} from '@samugen/platform-web'
import { buildAllRenderSlides, type Session } from '../domain/session'
import {
  deckDefaultFont,
  slideOps,
  type DeckClipboardStore,
  type ElementClipboardEntry,
  type LastSlidePaste,
  type OpsTranslate,
  type SlideClipboardEntry,
} from '../domain/ops'
import type {
  SlidesDeckClipboardPort,
  SlidesDocumentPort,
  SlidesAiPort,
  SlidesFilePort,
  SlidesLanguagePort,
  SlidesPlatform,
  SlidesPrintPort,
  SlidesWindowPort,
} from './platform'
import { buildPrintHtml } from '../domain/print-html'
import type { OpenResult } from '../shared/ipc'

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

/** The browser surfaces the file port needs, injected so this module reaches no global. */
export interface WebFileServices {
  /** The deck store: ref → handle, persisted in IndexedDB so a deck survives a reload. */
  store: WebDocumentStore
  /** Pickers for the one-off reads — a picture, a media file, a 3D model. */
  pickers: FilePickers
  /**
   * An image's own pixel size, which only a host can measure. `null` when the bytes cannot be
   * decoded, and the operation then falls back to 4:3 exactly as the desktop does.
   */
  imageSize: (bytes: Uint8Array, ext: string) => Promise<{ width: number; height: number } | null>
  /** Hand the deck to the user as a download, for a deck with nowhere to save to. */
  download: (fileName: string, bytes: Uint8Array) => void
}

/** An error's message, for the `error` field a failed save reports. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The pptx media type, for the Blob a download is delivered as. */
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const IMAGE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Images',
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/gif': ['.gif'],
      'image/bmp': ['.bmp'],
      'image/webp': ['.webp'],
      'image/tiff': ['.tif', '.tiff'],
    },
  },
]

const AV_TYPES: Record<'video' | 'audio', FilePickerAcceptType[]> = {
  video: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm'] } }],
  audio: [
    { description: 'Audio', accept: { 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg'] } },
  ],
}

const MODEL_TYPES: FilePickerAcceptType[] = [
  {
    description: '3D models',
    accept: { 'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf'] },
  },
]

/** Read one picked file, or `null` when the user dismissed the dialog. */
async function pickBytes(
  pickers: FilePickers,
  types: FilePickerAcceptType[],
  id: string,
): Promise<{ bytes: Uint8Array; name: string; ext: string } | null> {
  let handle
  try {
    handle = await pickers.openFile({ types, id })
  } catch (error) {
    if (isPickerCancel(error)) return null
    throw error
  }
  await ensurePermission(handle, 'read')
  const file = await handle.getFile()
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: file.name,
    ext: file.name.split('.').pop()?.toLowerCase() ?? '',
  }
}

/**
 * Getting a deck in and out of a browser.
 *
 * The store issues an opaque ref per document and resolves it to a `FileSystemFileHandle`, so
 * `OpenResult.path` carries that ref where Electron's carries an absolute path — and `name`
 * carries what to show, which is why the renderer no longer derives one.
 *
 * Two members report a capability this host does not have, and both do it through the value
 * their signature already allows rather than by pretending:
 *
 *   - `consumePendingOpen` — the desktop queues a document for a tab it is about to create.
 *     Nothing queues one here, so there is never a pending document and it answers `null`,
 *     which is the same answer the desktop gives for a tab opened empty.
 *   - `getRecentFiles` — returns paths, which the renderer puts straight in a list. This host
 *     has refs, and a ref is not something to show a user, so it reports none. The handles
 *     *are* persisted; surfacing them needs a name-carrying shape, the same gap pdf has.
 */
export function createWebSlidesFilePort(
  sessionSlot: WebSlidesSession,
  services: WebFileServices,
): SlidesFilePort {
  const { store, pickers } = services
  const session = () => sessionSlot.get()

  const adopt = async (ref: string, name: string, fitWidthPx: number): Promise<OpenResult> => {
    const opened = await openPptx(await store.read(ref))
    sessionSlot.open(ref, opened, fitWidthPx)
    return {
      path: ref,
      name,
      slides: buildAllRenderSlides(opened, fitWidthPx),
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      ...(deckDefaultFont(opened) ? { defaultFont: deckDefaultFont(opened) } : {}),
    }
  }

  /** Write the deck's current bytes to `ref`. `auto` never prompts; see WebDocumentStore.write. */
  const writeTo = async (ref: string, auto: boolean): Promise<void> => {
    const current = session()!
    await store.write(ref, await savePptx(current.opened), { prompt: !auto })
  }

  return {
    openPptx: async (fitWidthPx) => {
      const picked = await store.open()
      return picked ? adopt(picked.ref, picked.name, fitWidthPx) : null
    },

    // `path` is this host's own ref, handed back from the recent list or a reload.
    openPptxPath: async (path, fitWidthPx) => {
      const reopened = await store.reopen(path)
      return adopt(reopened.ref, reopened.name, fitWidthPx)
    },

    consumePendingOpen: async () => null,

    newBlank: async (fitWidthPx) => {
      const opened = await openPptx(await createBlankPptx())
      sessionSlot.open('', opened, fitWidthPx)
      return {
        path: '',
        name: '',
        slides: buildAllRenderSlides(opened, fitWidthPx),
        size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      }
    },

    /**
     * Save the deck where it already lives.
     *
     * A deck with no ref — a new blank one — has nowhere to live yet, and this host has no
     * folder it may write to unasked. A save the user asked for therefore goes through Save
     * As; an automatic one declines, because a dialog nobody asked for is the bug this flag
     * exists to prevent. That is the same rule docs' `saveNew` follows.
     */
    save: async (auto) => {
      const current = session()
      if (!current) return { ok: false, error: 'no file open' }
      if (!current.path) {
        if (auto) return { ok: false, error: 'not saved yet: use Save to choose a destination' }
        const saved = await store.saveAsDocument(
          'presentation.pptx',
          await savePptx(current.opened),
        )
        if (!saved) return { ok: false }
        current.path = saved.ref
        commitSaved(current.opened)
        current.metaDirty = false
        return {
          ok: true,
          path: saved.ref,
          name: saved.name,
          slides: buildAllRenderSlides(current.opened, current.fitWidthPx),
        }
      }
      try {
        await writeTo(current.path, auto)
        // Bake the saved patches back into the model, exactly as the desktop does: a reopen
        // would re-read and unzip the whole package and double the latency on a large deck.
        commitSaved(current.opened)
        current.metaDirty = false
        return {
          ok: true,
          path: current.path,
          name: (await store.recent()).find((r) => r.ref === current.path)?.name ?? '',
          slides: buildAllRenderSlides(current.opened, current.fitWidthPx),
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    saveAs: async (defaultName) => {
      const current = session()
      if (!current) return { ok: false, error: 'no file open' }
      try {
        const saved = await store.saveAsDocument(defaultName, await savePptx(current.opened))
        if (!saved) return { ok: false }
        current.path = saved.ref
        commitSaved(current.opened)
        current.metaDirty = false
        return {
          ok: true,
          path: saved.ref,
          name: saved.name,
          slides: buildAllRenderSlides(current.opened, current.fitWidthPx),
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    getRecentFiles: async () => [],

    insertImage: async (slideIndex, fitWidthPx) => {
      const picked = await pickBytes(pickers, IMAGE_TYPES, 'samugen-slides-image')
      if (!picked) return null
      const natural = (await services.imageSize(picked.bytes, picked.ext)) ?? {
        width: 4,
        height: 3,
      }
      return slideOps.insertPictureBytes(session(), {
        slideIndex,
        bytes: picked.bytes,
        ext: picked.ext,
        natural,
        fitWidthPx,
      })
    },

    editImageFill: async (op) => {
      const picked = await pickBytes(pickers, IMAGE_TYPES, 'samugen-slides-image')
      if (!picked) return null
      return slideOps.setImageFillBytes(session(), {
        slideIndex: op.slideIndex,
        sourceId: op.sourceId,
        bytes: picked.bytes,
        ext: picked.ext,
      })
    },

    insertMedia: async (slideIndex, kind, fitWidthPx) => {
      const picked = await pickBytes(pickers, AV_TYPES[kind], `samugen-slides-${kind}`)
      if (!picked) return null
      return slideOps.addMediaBytes(session(), {
        slideIndex,
        kind,
        base64: bytesToBase64(picked.bytes),
        ext: picked.ext,
        fitWidthPx,
        name: picked.name,
      })
    },

    insertModel3d: async (slideIndex, fitWidthPx) => {
      const picked = await pickBytes(pickers, MODEL_TYPES, 'samugen-slides-model')
      if (!picked) return null
      // No poster: the desktop asks the OS for a thumbnail and a page has no equivalent, so
      // the engine writes its own placeholder — which is also the desktop's fallback.
      return slideOps.addModel3dBytes(session(), {
        slideIndex,
        bytes: picked.bytes,
        ext: picked.ext,
        name: picked.name,
        fitWidthPx,
      })
    },

    /**
     * Insert an image the AI found on the web.
     *
     * Not available here, and the reason is the CSP rather than the API: every app is served
     * with `connect-src 'self'`, so the page cannot fetch an arbitrary image host. Routing it
     * through the BFF is the fix and needs a route that does not exist yet — the same gap
     * `search` is null for.
     */
    insertImageUrl: async () => null,
  }
}

/**
 * The window integration for a browser.
 *
 * What each member can honestly do depends on whether this page is standalone or a tab of
 * the web shell, and the difference is the `frame` argument rather than a runtime guess:
 *
 *   - `isDirty` works either way, and does not go anywhere to find out: the deck is in this
 *     page, so the same predicate the main process runs (`slideOps.isDirty`) runs here.
 *   - `onCloseSaveRequest` / `reportCloseSaveResult` are the desktop's "save, then tell me
 *     how it went, and I will wait" handshake. Standalone, nothing can make that request:
 *     `beforeunload` may not await anything, so the subscription is real and simply never
 *     fires, and the unload prompt below is what protects unsaved work — the browser's own
 *     "Leave site?" dialog, armed while the deck is dirty. In the shell there *is* someone
 *     who can wait: closing a tab removes the iframe, which `beforeunload` never sees, so
 *     the shell asks first and this port relays the question to the same subscriber the
 *     desktop's close guard reaches. Same arrangement docs has.
 *   - `setAutoSavePref` is accepted and recorded. On the desktop it tells the main process to
 *     save silently while closing a window; here there is no other process to tell, and an
 *     unload handler cannot await a write anyway.
 *   - `onOpened` / `onRenamed` are subscriptions with no emissions: nothing outside this page
 *     opens a document into it or renames one underneath it.
 */
export function createWebSlidesWindowPort(
  session: () => Session | undefined,
  unloadPrompt: typeof createWebUnloadPrompt = createWebUnloadPrompt,
  frame: FrameChildLink | null = null,
): SlidesWindowPort {
  let autoSave = false
  const isDirty = (): boolean => {
    const current = session()
    return !!current && slideOps.isDirty(current) === true
  }
  const closeSaveListeners = new Set<() => void>()
  // Installed once, for the life of the page: the browser's own leave-site prompt is the only
  // close guard a standalone page gets, and it must be armed before the first edit rather
  // than at close.
  unloadPrompt(isDirty)

  if (frame !== null) {
    // The shell's close check asks the same question the unload guard does, of the same
    // state, so a tab close and a window close cannot disagree.
    frame.onCloseCheck(isDirty)
    frame.onCloseSave(() => {
      if (closeSaveListeners.size === 0) {
        // Nobody is listening, so nothing will ever reply. Say so now rather than let the
        // shell wait out its deadline and reach the same answer.
        frame.reportCloseSave(false)
        return
      }
      for (const listener of closeSaveListeners) listener()
    })
  }

  return {
    isDirty: async () => isDirty(),
    setAutoSavePref: (on) => {
      autoSave = on
      void autoSave
    },
    onCloseSaveRequest: (handler) => {
      closeSaveListeners.add(handler)
      return () => void closeSaveListeners.delete(handler)
    },
    reportCloseSaveResult: (ok) => frame?.reportCloseSave(ok),
    onOpened: () => () => {},
    onRenamed: () => () => {},
  }
}

/**
 * The UI language, from the shared web language storage every app uses.
 *
 * The shared port verbatim. It used to cast, because slides declared a stale eleven-value copy
 * of @samugen/i18n's nineteen-value `Lang` (§6.4 of the migration doc) that a shared `Lang`
 * did not fit through. The bridge now says `Lang`, so the two agree.
 */
export function createWebSlidesLanguagePort(language: LanguagePort): SlidesLanguagePort {
  return language
}

/**
 * Printing, from a frame.
 *
 * The same HTML the desktop renders in a hidden window (src/domain/print-html.ts), so a
 * printout does not differ between hosts. It goes in an iframe rather than the page because
 * the page is the editor: printing the editor would print the editor.
 *
 * `printFrame` is injected — it is the only part that touches the DOM — and resolves once the
 * print dialog has closed, which a page can observe through `afterprint` in the frame.
 */
export function createWebSlidesPrintPort(
  printFrame: (html: string) => Promise<void>,
): SlidesPrintPort {
  return {
    printSlides: async (op) => {
      try {
        await printFrame(buildPrintHtml(op))
        // A page cannot tell whether the user printed or cancelled — the same limit docs
        // documented for its own print port — so this reports that the flow ran.
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/**
 * The AI port, over the BFF.
 *
 * Four of the five members are the shared `AiPort` verbatim — `getAiSettings`, `aiStream`,
 * `aiStreamCancel`, `onAiStream` — so `createWebAiPort` from @samugen/platform-web backs them
 * with no adapter at all, and slides streams through the same server route docs and pdf do. The
 * credential lives in the BFF and never reaches this page, which is the whole reason the route
 * exists.
 *
 * The fifth, `aiSnapshotRestore`, is not a network call: it rolls the deck back to a snapshot
 * this page holds, so it goes to the operations like every other document change.
 */
export function createWebSlidesAiPort(
  shared: AiPort,
  session: () => Session | undefined,
): SlidesAiPort {
  return {
    getAiSettings: () => shared.getAiSettings(),
    aiStream: (request) => shared.aiStream(request),
    aiStreamCancel: (requestId) => shared.aiStreamCancel(requestId),
    onAiStream: (handler) => shared.onAiStream(handler),
    aiSnapshotRestore: async (id) => slideOps.aiSnapshotRestore(session(), id),
  }
}

/** Everything the composed web platform needs from its host. */
export interface WebSlidesPlatformDeps {
  /** The page's one deck. Held by the host so the render env and the ports share it. */
  session: WebSlidesSession
  store: WebDocumentStore
  pickers: FilePickers
  language: LanguagePort
  ai: AiPort
  attachments: AttachmentsPort
  /** The services the document port cannot answer for itself. */
  document: WebDocumentServices
  /** An image's own pixel size; see `WebFileServices.imageSize`. */
  imageSize: WebFileServices['imageSize']
  /** Hand the deck to the user as a download, for a deck with nowhere to save to. */
  download: WebFileServices['download']
  /** Print the given HTML from a frame; see `createWebSlidesPrintPort`. */
  printFrame: (html: string) => Promise<void>
  /**
   * The web shell's frame link when this page is a tab of its strip, `null` when it is a
   * standalone browser tab. It is what makes the close guard real for a tab close, which
   * `beforeunload` cannot see. Same argument docs' platform takes.
   */
  frame?: FrameChildLink | null
  /** Install a `beforeunload` guard; injected so tests can drive it. Defaults to the real one. */
  unloadPrompt?: typeof createWebUnloadPrompt
}

/**
 * slides' platform for a browser: eight ports backed, nine answered `null`.
 *
 * The `null`s are the same list platform.ts documents, and each is a capability this host
 * genuinely lacks rather than one left for later — a second screen it cannot open, a system
 * clipboard it cannot read, a provider credential it must never hold, a filesystem of style
 * templates, a native menu bar. The renderer already tests every one of them, because
 * Electron's `SlidesApi` never had them optional; it has them non-null.
 *
 * `project` is `null` for a different reason and says so in platform.ts: the chat/project
 * store is a main-process database (§6.1), and no browser-side one exists yet.
 */
export function createWebSlidesPlatform(deps: WebSlidesPlatformDeps): SlidesPlatform {
  const session = () => deps.session.get()
  return {
    doc: createWebSlidesDocPort(session, deps.document),
    file: createWebSlidesFilePort(deps.session, {
      store: deps.store,
      pickers: deps.pickers,
      imageSize: deps.imageSize,
      download: deps.download,
    }),
    deckClipboard: createWebSlidesDeckClipboardPort(session),
    window: createWebSlidesWindowPort(session, deps.unloadPrompt, deps.frame ?? null),
    language: createWebSlidesLanguagePort(deps.language),
    ai: createWebSlidesAiPort(deps.ai, session),
    print: createWebSlidesPrintPort(deps.printFrame),
    attachments: deps.attachments,
    project: null,
    aiMedia: null,
    presenter: null,
    pdfExport: null,
    clipboard: null,
    search: null,
    styleTemplates: null,
    menu: null,
  }
}
