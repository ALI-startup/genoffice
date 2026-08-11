/**
 * The File System Access surface this host builds on, typed here rather than
 * taken from lib.dom.
 *
 * Two reasons for local types instead of the built-in `FileSystemFileHandle`:
 *
 *  1. lib.dom (TypeScript 5.9) types `FileSystemFileHandle.getFile()` and
 *     `.createWritable()` but not `queryPermission` / `requestPermission`, and
 *     it types none of `showOpenFilePicker` / `showSaveFilePicker` /
 *     `showDirectoryPicker`. The permission pair is exactly the part this host
 *     must not get wrong, so it has to be in the type system, not cast away at
 *     the call site.
 *  2. Structural, self-contained interfaces make the store unit-testable with a
 *     plain object fake. A real handle from a picker satisfies them
 *     structurally, so the only cast in the package is the one place that reads
 *     the pickers off `globalThis`.
 *
 * Chromium only, by decision: there is no feature-detection fallback here. If
 * the pickers are absent the host fails loudly at construction rather than
 * quietly degrading to a `<input type=file>` that cannot write back — losing
 * save-in-place is precisely the failure this phase exists to remove.
 */

export type FsPermissionMode = 'read' | 'readwrite'
export type FsPermissionState = 'granted' | 'denied' | 'prompt'

export interface FsPermissionDescriptor {
  mode: FsPermissionMode
}

/** The slice of `File` this package reads. A real `File` satisfies it. */
export interface WebFile {
  readonly name: string
  readonly size: number
  /**
   * Epoch millis of the file's last modification, i.e. `File.lastModified`.
   *
   * Present because it is half of the conflict check that stops a save from
   * overwriting another program's edits: together with `size` it is exactly
   * @genoffice/platform's `DiskFileState`, whose other producer is `fs.stat`.
   * Without it a browser host would have to write blind — see
   * `WebDocumentStore.stat`.
   */
  readonly lastModified: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** The slice of `FileSystemWritableFileStream` this package writes through. */
export interface WebWritableFile {
  write(data: BufferSource | Blob | string): Promise<void>
  close(): Promise<void>
}

/** The permission pair the spec puts on every handle and lib.dom does not type. */
export interface WebPermissionAware {
  queryPermission(descriptor: FsPermissionDescriptor): Promise<FsPermissionState>
  requestPermission(descriptor: FsPermissionDescriptor): Promise<FsPermissionState>
}

export interface WebFileHandle extends WebPermissionAware {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<WebFile>
  createWritable(options?: { keepExistingData?: boolean }): Promise<WebWritableFile>
}

export interface WebDirectoryHandle extends WebPermissionAware {
  readonly kind: 'directory'
  readonly name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WebFileHandle>
}

export interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

export interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[]
  excludeAcceptAllOption?: boolean
  /** Groups pickers that should reopen in the same directory. */
  id?: string
}

export interface SaveFilePickerOptions extends OpenFilePickerOptions {
  suggestedName?: string
}

export interface DirectoryPickerOptions {
  id?: string
  mode?: FsPermissionMode
}

/**
 * The three dialogs, injected so the store can be driven from tests. Each
 * returns exactly one handle and rejects with an `AbortError` on cancel — the
 * store turns that into `null` and never into a thrown error.
 */
export interface FilePickers {
  openFile(options?: OpenFilePickerOptions): Promise<WebFileHandle>
  saveFile(options?: SaveFilePickerOptions): Promise<WebFileHandle>
  directory(options?: DirectoryPickerOptions): Promise<WebDirectoryHandle>
}

export const PDF_FILE_TYPES: FilePickerAcceptType[] = [
  { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } },
]

export const DOCX_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Word Document',
    accept: {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
  },
]

/**
 * Image types for "insert a picture".
 *
 * png / jpeg / gif only, and deliberately not webp: the callers' result type
 * (apps/docs' `PickImageResult.mime`) is a three-value union, so offering a
 * fourth format in the dialog would let the user pick a file the caller cannot
 * describe.
 */
export const IMAGE_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Image',
    accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/gif': ['.gif'],
    },
  },
]

/** True for the rejection a picker produces when the user dismisses it. */
export function isPickerCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Raised when a handle exists but the user has not granted the access we need. */
export class FilePermissionDeniedError extends Error {
  override readonly name = 'FilePermissionDeniedError'
  constructor(
    readonly fileName: string,
    readonly mode: FsPermissionMode,
    readonly state: FsPermissionState,
  ) {
    super(
      `Permission to ${mode === 'readwrite' ? 'edit' : 'read'} "${fileName}" was not granted ` +
        `(permission state: ${state}). Reopen the file to grant access again.`,
    )
  }
}

/**
 * Make sure `handle` may be used in `mode`, prompting the user if it may not.
 *
 * This is the whole reason persisted handles are usable at all: a handle
 * restored from IndexedDB after a reload carries no permission, so it must be
 * queried and — when the answer is not 'granted' — re-requested. A denial (or a
 * `requestPermission` call outside a user gesture, which the browser rejects)
 * throws `FilePermissionDeniedError`, so a stale handle surfaces as a real
 * error instead of an empty read or a save that silently does nothing.
 */
export async function ensurePermission(
  handle: WebPermissionAware & { readonly name: string },
  mode: FsPermissionMode,
): Promise<void> {
  const queried = await handle.queryPermission({ mode })
  if (queried === 'granted') return
  const requested = await handle.requestPermission({ mode })
  if (requested === 'granted') return
  throw new FilePermissionDeniedError(handle.name, mode, requested)
}

interface PickerGlobals {
  showOpenFilePicker?: (
    options?: OpenFilePickerOptions & { multiple?: boolean },
  ) => Promise<WebFileHandle[]>
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<WebFileHandle>
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<WebDirectoryHandle>
}

/**
 * The real browser dialogs.
 *
 * The single cast in this package lives here: `globalThis` has no types for
 * these, and confining the cast to one function keeps every other module
 * checked against the interfaces above.
 */
export function browserFilePickers(scope: object = globalThis): FilePickers {
  const globals = scope as PickerGlobals
  const required = <T>(fn: T | undefined, api: string): T => {
    if (!fn) {
      throw new Error(
        `This browser does not support ${api}. GenOffice's web build requires the File System ` +
          `Access API (Chromium 86+); it is what lets the app save edits back into the file you opened.`,
      )
    }
    return fn
  }
  return {
    async openFile(options) {
      const [handle] = await required(globals.showOpenFilePicker, 'showOpenFilePicker').call(
        scope,
        { ...options, multiple: false },
      )
      // `multiple: false` guarantees exactly one entry; the spec has no
      // "resolved with nothing" case, so an empty array would be a browser bug.
      if (!handle) throw new Error('showOpenFilePicker resolved without a file handle')
      return handle
    },
    saveFile(options) {
      return required(globals.showSaveFilePicker, 'showSaveFilePicker').call(scope, options)
    },
    directory(options) {
      return required(globals.showDirectoryPicker, 'showDirectoryPicker').call(scope, options)
    },
  }
}

/**
 * A multi-select *read* dialog, for attachments.
 *
 * Separate from `FilePickers` on purpose. `FilePickers` is the handle-returning
 * surface the document store is built on, where every dialog yields exactly one
 * handle the app will later write back through. An attachment is the opposite
 * case: many files at once, read once, never written. So this returns plain
 * `WebFile`s — a snapshot of bytes and a name — and never asks for write
 * permission or persists anything.
 *
 * `null` means the user dismissed the dialog; every other failure throws.
 */
export type MultiFilePicker = (options?: OpenFilePickerOptions) => Promise<WebFile[] | null>

export function browserMultiFilePicker(scope: object = globalThis): MultiFilePicker {
  const globals = scope as PickerGlobals
  return async (options) => {
    const show = globals.showOpenFilePicker
    if (!show) {
      throw new Error(
        `This browser does not support showOpenFilePicker. GenOffice's web build requires the ` +
          `File System Access API (Chromium 86+).`,
      )
    }
    let handles: WebFileHandle[]
    try {
      handles = await show.call(scope, { ...options, multiple: true })
    } catch (error) {
      if (isPickerCancel(error)) return null
      throw error
    }
    // Read access is what a picker just granted, so no ensurePermission round
    // trip here — and no readwrite request, which would prompt for a grant this
    // surface must never hold.
    return Promise.all(handles.map((handle) => handle.getFile()))
  }
}
