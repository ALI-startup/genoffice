/**
 * Builds docs' platform for a browser, from a `WebDocumentStore` and a few injected browser
 * surfaces.
 */
import type { AiPort, AttachmentsPort, DiskFileState, LanguagePort } from '@samugen/platform'
import { isExternallyModified } from '@samugen/platform'
import type {
  FilePickers,
  FrameChildLink,
  WebDocumentStore,
  WebHwpConvertPort,
} from '@samugen/platform-web'
import {
  HWPX_FILE_TYPES,
  IMAGE_FILE_TYPES,
  createWebUnloadPrompt,
  ensurePermission,
  isPickerCancel,
} from '@samugen/platform-web'
import type { PickImageResult } from '../shared/ipc'
import type {
  CloseCheckState,
  DocsDownloadPort,
  DocsFilePort,
  DocsHwpxPort,
  DocsPlatform,
  DocsPrintPort,
  DocsWindowPort,
  DocumentRef,
  DownloadResult,
  HwpxExportResult,
  OpenOutcome,
  RecentDocument,
  SaveDocumentResult,
  SaveNamedDocumentResult,
} from './platform'
// The name tests belong to the codec that reads and writes the format; see its
// `formats.ts` for why a name is the right discriminant here — a `DocumentRef`
// is opaque and a picker hands back a handle rather than a type, so the name the
// user chose from a filtered dialog is all there is, and it is enough.
import { hwpxNameFor, isHwpName, isHwpxName } from '@samugen/hwpx-convert/formats'

/**
 * The one browser rule that shapes this host: `showSaveFilePicker` may only be called while the
 * page holds transient user activation.
 */
export interface UserActivationProbe {
  (): boolean
}

/** Said when a `.hwp` is picked and there is no converter behind it. */
const HWP_UNAVAILABLE = 'HWP conversion is not available here; save it as .hwpx'

/** Ask the user whether to overwrite a document another program has changed since it was opened. */
export interface ConfirmOverwrite {
  (): boolean
}

export interface WebDocsPlatformDeps {
  store: WebDocumentStore
  /** Used only for the image picker; the document dialogs go through the store. */
  pickers: FilePickers
  language: LanguagePort
  ai: AiPort
  attachments: AttachmentsPort
  hasUserActivation: UserActivationProbe
  confirmOverwrite: ConfirmOverwrite
  /** Install a `beforeunload` guard; injected so tests can drive it. Defaults to the real one. */
  unloadPrompt?: typeof createWebUnloadPrompt
  /**
   * The web shell's frame link when this page is hosted in its tab strip, `null` when it is a
   * standalone browser tab.
   */
  frame?: FrameChildLink | null
  /** Opens the browser's print dialog; injected so tests can drive it. Defaults to `window.print`. */
  printPage?: () => void
  /** Hands a file to the user's downloads. */
  deliverDownload: DownloadDelivery
  /** Reaches the `.hwp` → `.hwpx` service, for the one format this page cannot read itself. */
  hwp?: WebHwpConvertPort | null
}

/** Start a download of `data` under `fileName`. */
export interface DownloadDelivery {
  (fileName: string, data: ArrayBuffer, mimeType: string): void
}

/** docs' docx document surface over the File System Access API. */
export function createWebDocsFilePort(
  store: WebDocumentStore,
  pickers: FilePickers,
  hasUserActivation: UserActivationProbe,
  confirmOverwrite: ConfirmOverwrite,
  /** Reaches the `.hwp` → `.hwpx` service. */
  hwp: WebHwpConvertPort | null = null,
): DocsFilePort {
  /** What the file looked like the last time this host read or wrote it, per ref. */
  const disk = new Map<DocumentRef, DiskFileState>()

  /** Record the post-read/post-write state. Best-effort: an unstatable ref simply is not tracked. */
  const remember = async (ref: DocumentRef, hash: string): Promise<void> => {
    try {
      const { lastModified, size } = await store.stat(ref)
      disk.set(ref, { mtimeMs: lastModified, size, hash })
    } catch {
      /* not tracked; the next save then cannot flag a conflict, exactly as in main */
    }
  }

  /** Read a document the store has already granted us, as the renderer wants it. */
  const load = async (ref: DocumentRef, name: string): Promise<OpenOutcome> => {
    const bytes = await store.read(ref)
    if (isHwpxName(name)) return importHwpx(ref, name, bytes)
    if (isHwpName(name)) return importHwp(ref, name, bytes)
    const data = toArrayBuffer(bytes)
    const hash = await sha256Hex(data)
    await remember(ref, hash)
    return { kind: 'document', document: { ref, name, data, hash } }
  }

  /** Read a picked `.hwpx` into the editor, still bound to its file. */
  const importHwpx = async (
    ref: DocumentRef,
    name: string,
    bytes: Uint8Array,
  ): Promise<OpenOutcome> => {
    // Loaded on demand: the converter is the heaviest thing in this bundle and a
    // session that never opens a .hwpx should not download it.
    const { hwpxToHtml } = await import('@samugen/hwpx-convert')
    try {
      const imported = await hwpxToHtml(bytes)
      // The baseline a later in-place save compares against.
      await remember(ref, await sha256Hex(toArrayBuffer(bytes)))
      return {
        kind: 'import',
        imported: { ...imported, sourceName: name, name, ref, format: 'hwpx' },
      }
    } catch (error) {
      await store.forget(ref).catch(() => {})
      throw error
    }
  }

  /** Convert a picked `.hwp` and hand the result over as an unsaved document. */
  const importHwp = async (
    ref: DocumentRef,
    name: string,
    bytes: Uint8Array,
  ): Promise<OpenOutcome> => {
    try {
      if (!hwp) throw new Error(HWP_UNAVAILABLE)
      const converted = await hwp.toHwpx(bytes)
      if (!converted.ok) {
        throw new Error(
          converted.reason === 'unsupported' || converted.reason === 'unreachable'
            ? HWP_UNAVAILABLE
            : converted.error,
        )
      }
      const { hwpxToHtml } = await import('@samugen/hwpx-convert')
      const imported = await hwpxToHtml(converted.bytes)
      return {
        kind: 'import',
        imported: {
          ...imported,
          sourceName: name,
          name: hwpxNameFor(name),
          ref: null,
          format: 'hwpx',
        },
      }
    } finally {
      await store.forget(ref).catch(() => {})
    }
  }

  /** Has another program written this document since we last read or wrote it? */
  const changedExternally = async (ref: DocumentRef): Promise<boolean> => {
    let current: { mtimeMs: number; size: number } | null
    try {
      const { lastModified, size } = await store.stat(ref)
      current = { mtimeMs: lastModified, size }
    } catch {
      // Unreadable now (deleted, or the grant lapsed): not a conflict, and the
      // write below reports its own failure if it cannot proceed.
      current = null
    }
    return isExternallyModified(disk.get(ref), current, async () => {
      try {
        return await sha256Hex(await store.read(ref))
      } catch {
        return null
      }
    })
  }

  return {
    /**
     * Always null, and honestly so: "pending" means a host queued a document into this view when it
     * created it.
     */
    consumePending: async () => null,

    /**
     * True, because that is what actually happened: a fresh browser tab of the app *is* a new blank
     * document.
     */
    consumeNewBlank: async () => true,

    /** A real subscription this host never emits for. */
    onOpenDocument: () => () => {},

    /** A real subscription this host never emits for. */
    onDocumentRenamed: () => () => {},

    openDocument: async () => {
      const picked = await store.open()
      return picked ? load(picked.ref, picked.name) : null
    },

    openDocumentByRef: async (ref) => {
      // `reopen` is what makes the recent list work across reloads: the handle comes back from
      // IndexedDB with no permission, and it re-prompts.
      const reopened = await store.reopen(ref)
      return load(reopened.ref, reopened.name)
    },

    /**
     * Save in place, through a writable stream — the same file the user opened, not a download into
     * ~/Downloads.
     */
    save: async (ref, data, auto): Promise<SaveDocumentResult> => {
      try {
        if (await changedExternally(ref)) {
          if (auto === true) return { ok: false, reason: 'external-modified' }
          if (!confirmOverwrite()) return { ok: false, reason: 'external-modified' }
        }
        // Checked before the write rather than caught after it, so an autosave that cannot proceed
        // is a reported outcome and not an exception mapped back into one.
        if (auto === true && !(await store.writable(ref))) {
          return { ok: false, reason: 'needs-permission' }
        }
        const bytes = new Uint8Array(data)
        await store.write(ref, bytes, { prompt: auto !== true })
        // Re-baseline from what we just wrote, or the next save would flag our own
        // write as somebody else's.
        await remember(ref, await sha256Hex(bytes))
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    saveAs: (defaultName, data) => saveNamed(store, remember, defaultName, data),

    /** The "silent first save" that cannot be silent. */
    saveNew: async (defaultName, data, auto): Promise<SaveNamedDocumentResult> => {
      if (auto || !hasUserActivation()) return { ok: false, reason: 'needs-user-gesture' }
      return saveNamed(store, remember, defaultName, data)
    },

    /** No host-owned recovery location, and nothing that would read one; see the file header. */
    writeRecoveryCopy: async () => ({ ok: false }),

    /**
     * Neither half of the renderer's recovery tick can land anywhere in a browser: there is no
     * host-owned location for a copy, and naming a never-saved document needs a dialog nobody asked
     * for.
     */
    crashRecovery: false,

    /** The store's own recent list, which survives a reload because the handles do. */
    recentDocuments: async (): Promise<RecentDocument[]> =>
      (await store.recent()).map(({ ref, name }) => ({ ref, name })),

    pickImage: async (): Promise<PickImageResult | null> => {
      let handle
      try {
        handle = await pickers.openFile({ types: IMAGE_FILE_TYPES, id: 'samugen-image' })
      } catch (error) {
        if (isPickerCancel(error)) return null
        throw error
      }
      await ensurePermission(handle, 'read')
      const file = await handle.getFile()
      const mime = imageMimeOf(file.name)
      // The dialog is filtered to png/jpeg/gif, so this is unreachable unless the
      // user defeats the filter; failing loudly beats returning a wrong mime.
      if (!mime) throw new Error(`${file.name} is not a PNG, JPEG or GIF image`)
      return { base64: toBase64(new Uint8Array(await file.arrayBuffer())), mime, name: file.name }
    },
  }
}

/** docs' window integration for a browser. */
export function createWebDocsWindowPort(
  installUnloadPrompt: typeof createWebUnloadPrompt = createWebUnloadPrompt,
  frame: FrameChildLink | null = null,
): DocsWindowPort {
  const closeCheckListeners = new Set<() => void>()
  const closeSaveListeners = new Set<() => void>()
  /** Mailbox for the reply to the request currently in flight. */
  const replies: CloseCheckState[] = []

  /** Ask every subscriber, synchronously, whether closing would lose work. */
  const wouldLoseWork = (): boolean => {
    if (closeCheckListeners.size === 0) return false
    for (const listener of closeCheckListeners) {
      replies.length = 0
      listener()
      const reply = replies.shift()
      // No reply, or a dirty one: prompt.
      if (reply === undefined || reply.dirty) {
        replies.length = 0
        return true
      }
    }
    replies.length = 0
    return false
  }

  installUnloadPrompt(wouldLoseWork)

  if (frame !== null) {
    // The shell's close check asks the same question the unload guard does, of
    // the same subscribers, so a tab close and a window close cannot disagree.
    frame.onCloseCheck(wouldLoseWork)
    frame.onCloseSave(() => {
      if (closeSaveListeners.size === 0) {
        // Nobody is listening, so nothing will ever reply.
        frame.reportCloseSave(false)
        return
      }
      for (const listener of closeSaveListeners) listener()
    })
  }

  return {
    // A browser draws neither the window frame nor a menu bar.
    nativeChrome: false,
    onCloseCheck(handler: () => void): () => void {
      closeCheckListeners.add(handler)
      return () => void closeCheckListeners.delete(handler)
    },
    reportCloseCheck(state: CloseCheckState): void {
      replies.push(state)
    },
    onCloseSaveRequest(handler: () => void): () => void {
      closeSaveListeners.add(handler)
      return () => void closeSaveListeners.delete(handler)
    },
    reportCloseSaveResult: (ok: boolean) => {
      if (frame !== null) {
        frame.reportCloseSave(ok)
        return
      }
      console.warn(
        `[docs] close-save result (${ok}) reported, but this host never issues a close-save ` +
          `request. Something is calling the reply half of the handshake directly.`,
      )
    },
    onTeardown: () => () => {},
    onMenuCommand: () => () => {},
  }
}

/** The browser's print flow, which is `window.print()` and nothing else. */
export function createWebDocsPrintPort(
  printPage: () => void = () => window.print(),
): DocsPrintPort {
  return {
    print: () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener('afterprint', done)
          resolve()
        }
        window.addEventListener('afterprint', done)
        printPage()
      }),
  }
}

export function createWebDocsPlatform(deps: WebDocsPlatformDeps): DocsPlatform {
  return {
    language: deps.language,
    ai: deps.ai,
    attachments: deps.attachments,
    window: createWebDocsWindowPort(deps.unloadPrompt, deps.frame ?? null),
    file: createWebDocsFilePort(
      deps.store,
      deps.pickers,
      deps.hasUserActivation,
      deps.confirmOverwrite,
      deps.hwp ?? null,
    ),
    // The four capabilities a browser cannot back.
    tabs: null,
    search: null,
    // Still null after Phase 4c, and permanently: PDF *export* writes a file the renderer would
    // have to draw itself, and a rasterised or re-laid-out approximation under the same command
    // name would misreport what happened.
    pdfExport: null,
    hwpx: createWebDocsHwpxPort(deps.store),
    print: createWebDocsPrintPort(deps.printPage),
    // Non-null exactly where Electron's is null.
    download: createWebDocsDownloadPort(deps.deliverDownload),
  }
}

/** The docx media type, for the Blob a download is delivered as. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
/** The OWPML media type, for the same reason. */
const HWPX_DOWNLOAD_MIME = 'application/hwp+zip'

/** Download the open document, in the format it is in. */
export function createWebDocsDownloadPort(deliver: DownloadDelivery): DocsDownloadPort {
  return {
    download: async (defaultName, data): Promise<DownloadResult> => {
      // The caller serializes to whichever format the document is in, and a name
      // is all this port has to go on — so the name decides the media type, and
      // anything that is neither is corrected to `.docx` rather than trusted.
      const hangul = isHwpxName(defaultName)
      const name =
        hangul || /\.docx$/i.test(defaultName)
          ? defaultName
          : `${defaultName.replace(/\.[^./\\]*$/, '')}.docx`
      try {
        deliver(name, data, hangul ? HWPX_DOWNLOAD_MIME : DOCX_MIME)
        return { ok: true, name }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/** HWPX export, entirely in the browser. */
export function createWebDocsHwpxPort(store: WebDocumentStore): DocsHwpxPort {
  return {
    /**
     * The bytes an in-place save writes, and nothing else — no dialog, no ref, no
     * recent-list entry, because the caller already has all three.
     */
    convert: async (html): Promise<ArrayBuffer> => {
      const { htmlToHwpx } = await import('@samugen/hwpx-convert')
      const bytes = await htmlToHwpx(html)
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
    },

    exportDocument: async (defaultName, html): Promise<HwpxExportResult> => {
      try {
        // On demand: the converter is the heaviest thing in this bundle, and a
        // session that never exports should not download it.
        const { htmlToHwpx } = await import('@samugen/hwpx-convert')
        const bytes = await htmlToHwpx(html)
        const suggested = hwpxNameFor(defaultName)
        const written = await store.saveBytesAs(suggested, bytes, HWPX_FILE_TYPES)
        // A dismissed dialog is `ok: false` with no error, matching the PDF
        // export port's convention; the caller reports it as a cancellation.
        if (written === null) return { ok: false }
        // A browser gives a name, never a path.
        return { ok: true, path: written }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/**
 * A save that had to name the document: pick a destination, write, adopt it, and record the disk
 * baseline so the next in-place save can detect a conflict.
 */
async function saveNamed(
  store: WebDocumentStore,
  remember: (ref: DocumentRef, hash: string) => Promise<void>,
  defaultName: string,
  data: ArrayBuffer,
): Promise<SaveNamedDocumentResult> {
  try {
    const bytes = new Uint8Array(data)
    const saved = await store.saveAsDocument(withDocumentExtension(defaultName), bytes)
    if (saved === null) return { ok: false }
    await remember(saved.ref, await sha256Hex(bytes))
    return { ok: true, ref: saved.ref, name: saved.name }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** The suggested name a save dialog opens with. */
function withDocumentExtension(name: string): string {
  if (isHwpxName(name)) return name
  return /\.docx$/i.test(name) ? name : `${name}.docx`
}

const IMAGE_MIME_BY_EXT: Record<string, PickImageResult['mime']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

function imageMimeOf(name: string): PickImageResult['mime'] | undefined {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? IMAGE_MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] : undefined
}

/**
 * `OpenedDocument.data` is declared as an `ArrayBuffer` because that is what the Electron IPC
 * channel hands back.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** sha256 as lowercase hex, matching the main process's `sha256Hex`. */
async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data)
  // The cast is the same one the other hosts' hashes carry: TS models BufferSource as
  // holding an `ArrayBuffer`, and a `Uint8Array<ArrayBufferLike>` does not fit that.
  const digest = await crypto.subtle.digest('SHA-256', view as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Bytes → raw base64, without the `data:` prefix. Chunked: spreading megabytes blows the argument limit. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
