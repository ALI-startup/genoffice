/**
 * Fakes for the browser surfaces the document store sits on.
 *
 * The store is written against the interfaces in src/fs-access.ts precisely so
 * these can be plain objects: no jsdom, no IndexedDB polyfill, and — the part
 * that matters — the permission answers are scriptable, so the denied path is a
 * first-class test case rather than something only reachable by hand.
 */
import type {
  FilePickers,
  FsPermissionDescriptor,
  FsPermissionState,
  WebDirectoryHandle,
  WebFileHandle,
} from '../src/fs-access'
import type { DocumentHandleStore, StoredDocumentHandle } from '../src/handle-store'

export interface PermissionLog {
  queried: FsPermissionDescriptor[]
  requested: FsPermissionDescriptor[]
}

export interface FakeFileHandle extends WebFileHandle {
  /** Current file contents, replaced by every completed write. */
  contents: Uint8Array
  permissions: PermissionLog
  /** Answers `queryPermission`; 'prompt' makes the store fall through to a request. */
  queryState: FsPermissionState
  /** Answers `requestPermission`; 'denied' drives the permission-denied path. */
  requestState: FsPermissionState
}

export function fakeFileHandle(
  name: string,
  initial: Uint8Array = new Uint8Array(),
): FakeFileHandle {
  const handle: FakeFileHandle = {
    kind: 'file',
    name,
    contents: initial,
    permissions: { queried: [], requested: [] },
    queryState: 'granted',
    requestState: 'granted',
    async queryPermission(descriptor) {
      handle.permissions.queried.push(descriptor)
      return handle.queryState
    },
    async requestPermission(descriptor) {
      handle.permissions.requested.push(descriptor)
      // A real browser leaves the handle granted afterwards; mirror that so a
      // second access in the same test does not prompt again.
      if (handle.requestState === 'granted') handle.queryState = 'granted'
      return handle.requestState
    },
    async getFile() {
      return {
        name: handle.name,
        size: handle.contents.byteLength,
        arrayBuffer: async () =>
          handle.contents.buffer.slice(
            handle.contents.byteOffset,
            handle.contents.byteOffset + handle.contents.byteLength,
          ) as ArrayBuffer,
      }
    },
    async createWritable() {
      const parts: Uint8Array[] = []
      return {
        async write(data) {
          parts.push(new Uint8Array(data as ArrayBuffer))
        },
        async close() {
          const total = parts.reduce((n, part) => n + part.byteLength, 0)
          const merged = new Uint8Array(total)
          let offset = 0
          for (const part of parts) {
            merged.set(part, offset)
            offset += part.byteLength
          }
          handle.contents = merged
        },
      }
    },
  }
  return handle
}

export interface FakeDirectoryHandle extends WebDirectoryHandle {
  files: Map<string, FakeFileHandle>
}

export function fakeDirectoryHandle(name: string): FakeDirectoryHandle {
  const files = new Map<string, FakeFileHandle>()
  return {
    kind: 'directory',
    name,
    files,
    async queryPermission() {
      return 'granted'
    },
    async requestPermission() {
      return 'granted'
    },
    async getFileHandle(fileName) {
      const existing = files.get(fileName)
      if (existing) return existing
      const created = fakeFileHandle(fileName)
      files.set(fileName, created)
      return created
    },
  }
}

/** The rejection every picker produces when the user dismisses the dialog. */
export function pickerCancel(): Error {
  const error = new Error('The user aborted a request.')
  error.name = 'AbortError'
  return error
}

export interface FakePickers extends FilePickers {
  /** Queued answers; each entry is a handle to return or an error to reject with. */
  openQueue: (WebFileHandle | Error)[]
  saveQueue: (WebFileHandle | Error)[]
  directoryQueue: (WebDirectoryHandle | Error)[]
}

export function fakePickers(): FakePickers {
  const next = <T>(queue: (T | Error)[], api: string): Promise<T> => {
    const value = queue.shift()
    if (value === undefined) return Promise.reject(new Error(`${api}: nothing queued`))
    if (value instanceof Error) return Promise.reject(value)
    return Promise.resolve(value)
  }
  const pickers: FakePickers = {
    openQueue: [],
    saveQueue: [],
    directoryQueue: [],
    openFile: () => next(pickers.openQueue, 'openFile'),
    saveFile: () => next(pickers.saveQueue, 'saveFile'),
    directory: () => next(pickers.directoryQueue, 'directory'),
  }
  return pickers
}

/**
 * Stand-in for IndexedDB.
 *
 * Entries are kept as-is (a real structured clone would copy the handle, but
 * the browser hands back a live handle object, which is what the store relies
 * on), so a "reload" is modelled by building a second store over the same map.
 */
export function fakeHandleStore(): DocumentHandleStore & {
  entries: Map<string, StoredDocumentHandle>
} {
  const entries = new Map<string, StoredDocumentHandle>()
  return {
    entries,
    put: async (entry) => void entries.set(entry.ref, entry),
    get: async (ref) => entries.get(ref),
    list: async () => [...entries.values()].sort((a, b) => b.openedAt - a.openedAt),
    delete: async (ref) => void entries.delete(ref),
  }
}
