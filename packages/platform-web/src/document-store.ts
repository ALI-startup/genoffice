/** The browser's answer to "what is a DocumentRef?". */
import type { PdfBytesIo } from '@samugen/pdf-edit'
import {
  ensurePermission,
  FilePermissionDeniedError,
  isPickerCancel,
  PDF_FILE_TYPES,
  type FilePickerAcceptType,
  type FilePickers,
  type WebDirectoryHandle,
  type WebFileHandle,
} from './fs-access.js'
import type { DocumentHandleStore, StoredDocumentHandle } from './handle-store.js'

/** An opaque ref plus the only display information a browser can honestly give. */
export interface WebDocument {
  ref: string
  name: string
}

export interface WebRecentDocument extends WebDocument {
  openedAt: number
}

/** A picked output folder, narrowed to the one thing callers do with it. */
export interface WebDirectory {
  name: string
  writeFile(fileName: string, bytes: Uint8Array): Promise<void>
}

/** Raised for a ref this store never issued, or one whose handle has been forgotten. */
export class UnknownDocumentError extends Error {
  override readonly name = 'UnknownDocumentError'
  constructor(ref: string) {
    super(
      `No document handle for ref "${ref}". It was never opened in this browser, or the ` +
        `browser dropped its stored handle; open the file again.`,
    )
  }
}

export interface WebDocumentStoreOptions {
  handles: DocumentHandleStore
  pickers: FilePickers
  /** File types every dialog this store opens is filtered to. */
  fileTypes?: FilePickerAcceptType[]
  /**
   * Groups this store's dialogs so the browser reopens them in the last
   * directory used *for this format*. Defaults to `samugen-pdf`.
   */
  pickerId?: string
  /** Injected for tests; production uses `crypto.randomUUID`. */
  newRef?: () => string
  /** Injected for tests; production uses `Date.now`. */
  now?: () => number
}

/** Options for `WebDocumentStore.write`. */
export interface WriteOptions {
  /** May this write open the browser's write-permission dialog? */
  prompt?: boolean
}

export class WebDocumentStore {
  private readonly handles: DocumentHandleStore
  private readonly pickers: FilePickers
  private readonly fileTypes: FilePickerAcceptType[]
  private readonly pickerId: string
  private readonly newRef: () => string
  private readonly now: () => number
  /** Handles granted in this session. Authoritative while the page lives. */
  private readonly live = new Map<string, WebFileHandle>()
  private readonly dialogListeners = new Set<(open: boolean) => void>()
  private openDialogs = 0

  constructor(options: WebDocumentStoreOptions) {
    this.handles = options.handles
    this.pickers = options.pickers
    this.fileTypes = options.fileTypes ?? PDF_FILE_TYPES
    this.pickerId = options.pickerId ?? 'samugen-pdf'
    this.newRef = options.newRef ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  /** Show the open dialog and adopt the picked file as a document. */
  async open(): Promise<WebDocument | null> {
    const handle = await this.withDialog(() =>
      this.pickers.openFile({ types: this.fileTypes, id: this.pickerId }),
    ).catch(cancelToNull)
    if (!handle) return null
    return this.adopt(handle)
  }

  /** Reuse a document opened in an earlier session; prompts for permission if needed. */
  async reopen(ref: string): Promise<WebDocument> {
    const stored = await this.handles.get(ref)
    if (!stored) throw new UnknownDocumentError(ref)
    await this.grant(stored.handle)
    this.live.set(ref, stored.handle)
    await this.handles.put({ ...stored, openedAt: this.now() })
    return { ref, name: stored.handle.name || stored.name }
  }

  /** Previously opened documents, most recent first. Handles are not touched, so this never prompts. */
  async recent(): Promise<WebRecentDocument[]> {
    const stored = await this.handles.list()
    return stored.map(({ ref, name, openedAt }) => ({ ref, name, openedAt }))
  }

  /** Drop a document from the recent list and release its handle. */
  async forget(ref: string): Promise<void> {
    this.live.delete(ref)
    await this.handles.delete(ref)
  }

  async read(ref: string): Promise<Uint8Array> {
    const handle = await this.handleFor(ref)
    const file = await handle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  }

  /** The document's current last-modified time and size — a browser's `fs.stat`. */
  async stat(ref: string): Promise<{ lastModified: number; size: number }> {
    const file = await (await this.handleFor(ref)).getFile()
    return { lastModified: file.lastModified, size: file.size }
  }

  /** May this document be written *without asking the user*? */
  async writable(ref: string): Promise<boolean> {
    const handle = await this.handleFor(ref)
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'
  }

  /** Overwrite the document in place. */
  async write(ref: string, bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const handle = await this.handleFor(ref)
    // A session handle may hold read-only permission even though it never left
    // memory: `showOpenFilePicker` grants read, and write is a second grant.
    //
    // `prompt: false` is for a write nobody asked for.
    if (options.prompt === false) {
      if (!(await this.writable(ref))) {
        throw new FilePermissionDeniedError(handle.name, 'readwrite', 'prompt')
      }
    } else {
      await this.grant(handle)
    }
    const writable = await handle.createWritable()
    try {
      await writable.write(toBlobPart(bytes))
    } finally {
      await writable.close()
    }
  }

  /** The `PdfBytesIo` for a document — the seam that makes save-in-place work. */
  bytesIo(ref: string): PdfBytesIo {
    return {
      read: () => this.read(ref),
      write: (bytes) => this.write(ref, bytes),
    }
  }

  /** Read a one-off file (e.g. a PDF to merge in) without minting a ref for it. */
  async pickBytes(): Promise<Uint8Array | null> {
    const handle = await this.withDialog(() =>
      this.pickers.openFile({ types: this.fileTypes, id: this.pickerId }),
    ).catch(cancelToNull)
    if (!handle) return null
    await ensurePermission(handle, 'read')
    const file = await handle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  }

  /** Write bytes to a destination the user picks. */
  async saveBytesAs(
    suggestedName: string,
    bytes: Uint8Array,
    /**
     * Accepted types for this write, when the artifact is not the store's own document format —
     * exporting `.hwpx` out of a `.docx` store, for instance.
     */
    types: FilePickerAcceptType[] = this.fileTypes,
  ): Promise<string | null> {
    const handle = await this.withDialog(() =>
      this.pickers.saveFile({ types, suggestedName, id: this.pickerId }),
    ).catch(cancelToNull)
    if (!handle) return null
    await ensurePermission(handle, 'readwrite')
    const writable = await handle.createWritable()
    try {
      await writable.write(toBlobPart(bytes))
    } finally {
      await writable.close()
    }
    return handle.name
  }

  /** Save As: write bytes to a destination the user picks, then *adopt* it as the open document. */
  async saveAsDocument(suggestedName: string, bytes: Uint8Array): Promise<WebDocument | null> {
    const handle = await this.withDialog(() =>
      this.pickers.saveFile({ types: this.fileTypes, suggestedName, id: this.pickerId }),
    ).catch(cancelToNull)
    if (!handle) return null
    await ensurePermission(handle, 'readwrite')
    const writable = await handle.createWritable()
    try {
      await writable.write(toBlobPart(bytes))
    } finally {
      await writable.close()
    }
    return this.adopt(handle)
  }

  /** Pick an output folder (image export). `null` on cancel. */
  async pickDirectory(): Promise<WebDirectory | null> {
    const handle = await this.withDialog(() =>
      this.pickers.directory({ mode: 'readwrite', id: 'samugen-export' }),
    ).catch(cancelToNull)
    if (!handle) return null
    await ensurePermission(handle, 'readwrite')
    return directoryWriter(handle)
  }

  /** Fires `true` while any host dialog is open and `false` once it closes. */
  onDialog(handler: (open: boolean) => void): () => void {
    this.dialogListeners.add(handler)
    return () => void this.dialogListeners.delete(handler)
  }

  /** Mint a ref for a freshly picked handle and remember it in both maps. */
  private async adopt(handle: WebFileHandle): Promise<WebDocument> {
    const ref = this.newRef()
    this.live.set(ref, handle)
    const entry: StoredDocumentHandle = { ref, name: handle.name, handle, openedAt: this.now() }
    // A browser with IndexedDB blocked (private mode, storage pressure) can still work for this
    // session — losing the recent list must not lose the document the user just opened.
    await this.handles.put(entry).catch((error: unknown) => {
      console.warn('[platform-web] could not persist the file handle:', error)
    })
    return { ref, name: handle.name }
  }

  /** Resolve a ref to a usable handle. */
  private async handleFor(ref: string): Promise<WebFileHandle> {
    const live = this.live.get(ref)
    if (live) return live
    const stored = await this.handles.get(ref)
    if (!stored) throw new UnknownDocumentError(ref)
    await this.grant(stored.handle)
    this.live.set(ref, stored.handle)
    return stored.handle
  }

  /** Read-write is the only mode this store asks for: an editor that cannot write back is the shim we are deleting. */
  private grant(handle: WebFileHandle): Promise<void> {
    return ensurePermission(handle, 'readwrite')
  }

  private async withDialog<T>(run: () => Promise<T>): Promise<T> {
    this.setDialogs(this.openDialogs + 1)
    try {
      return await run()
    } finally {
      this.setDialogs(this.openDialogs - 1)
    }
  }

  private setDialogs(count: number): void {
    const before = this.openDialogs > 0
    this.openDialogs = Math.max(0, count)
    const after = this.openDialogs > 0
    if (before !== after) for (const listener of this.dialogListeners) listener(after)
  }
}

function directoryWriter(handle: WebDirectoryHandle): WebDirectory {
  return {
    name: handle.name,
    async writeFile(fileName, bytes) {
      const file = await handle.getFileHandle(fileName, { create: true })
      const writable = await file.createWritable()
      try {
        await writable.write(toBlobPart(bytes))
      } finally {
        await writable.close()
      }
    },
  }
}

/**
 * `Uint8Array` is a `BufferSource`, but a view over a pooled `ArrayBuffer` (as pdf-lib may return)
 * would write the whole backing buffer if passed as one.
 */
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function cancelToNull(error: unknown): null {
  if (isPickerCancel(error)) return null
  throw error
}
