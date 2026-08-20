/**
 * The File System Access surface this host builds on, typed here rather than taken from lib.dom.
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
  /** Epoch millis of the file's last modification, i.e. */
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

/** The three dialogs, injected so the store can be driven from tests. */
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

/** The OWPML package, which docs reads, writes and exports. */
export const HWPX_FILE_TYPES: FilePickerAcceptType[] = [
  { description: 'Hangul Document', accept: { 'application/hwp+zip': ['.hwpx'] } },
]

/** Everything docs can open. */
export const DOCUMENT_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Documents',
    accept: {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/hwp+zip': ['.hwpx'],
      'application/x-hwp': ['.hwp'],
    },
  },
]

/** PowerPoint presentations, which slides opens and saves. */
export const PRESENTATION_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'PowerPoint Presentation',
    accept: {
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
    },
  },
]

/** Image types for "insert a picture". */
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

/** Make sure `handle` may be used in `mode`, prompting the user if it may not. */
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

/** The real browser dialogs. */
export function browserFilePickers(scope: object = globalThis): FilePickers {
  const globals = scope as PickerGlobals
  const required = <T>(fn: T | undefined, api: string): T => {
    if (!fn) {
      throw new Error(
        `This browser does not support ${api}. SamuGen's web build requires the File System ` +
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

/** A multi-select *read* dialog, for attachments. */
export type MultiFilePicker = (options?: OpenFilePickerOptions) => Promise<WebFile[] | null>

export function browserMultiFilePicker(scope: object = globalThis): MultiFilePicker {
  const globals = scope as PickerGlobals
  return async (options) => {
    const show = globals.showOpenFilePicker
    if (!show) {
      throw new Error(
        `This browser does not support showOpenFilePicker. SamuGen's web build requires the ` +
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
    // Read access is what a picker just granted, so no ensurePermission round trip here — and no
    // readwrite request, which would prompt for a grant this surface must never hold.
    return Promise.all(handles.map((handle) => handle.getFile()))
  }
}
