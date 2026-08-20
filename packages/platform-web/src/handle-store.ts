/** Persistence for the ref → handle mapping. */
import type { WebFileHandle } from './fs-access.js'

export interface StoredDocumentHandle {
  /** The opaque ref the document store issued for this handle. */
  ref: string
  /** Display name at the time it was opened, e.g. `report.pdf`. */
  name: string
  handle: WebFileHandle
  /** Epoch millis of the most recent open, for ordering the recent list. */
  openedAt: number
}

export interface DocumentHandleStore {
  put(entry: StoredDocumentHandle): Promise<void>
  get(ref: string): Promise<StoredDocumentHandle | undefined>
  /** Most recently opened first. */
  list(): Promise<StoredDocumentHandle[]>
  delete(ref: string): Promise<void>
}

export const DOCUMENT_DB_NAME = 'samugen-web-host'
export const DOCUMENT_STORE_NAME = 'documents'

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** Non-persistent fallback so a private-mode / blocked-IndexedDB browser still opens files for this session. */
export function createMemoryHandleStore(): DocumentHandleStore {
  const entries = new Map<string, StoredDocumentHandle>()
  return {
    put: async (entry) => void entries.set(entry.ref, entry),
    get: async (ref) => entries.get(ref),
    list: async () => [...entries.values()].sort((a, b) => b.openedAt - a.openedAt),
    delete: async (ref) => void entries.delete(ref),
  }
}

/** IndexedDB-backed store, keyed by ref. */
export function createIndexedDbHandleStore(
  factory: IDBFactory = indexedDB,
  dbName: string = DOCUMENT_DB_NAME,
): DocumentHandleStore {
  let opening: Promise<IDBDatabase> | undefined

  const db = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(dbName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DOCUMENT_STORE_NAME)) {
          request.result.createObjectStore(DOCUMENT_STORE_NAME, { keyPath: 'ref' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'))
    }).catch((error: unknown) => {
      // Let the next call retry rather than caching a rejected promise forever.
      opening = undefined
      throw error
    })
    return opening
  }

  const tx = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const connection = await db()
    const transaction = connection.transaction(DOCUMENT_STORE_NAME, mode)
    const result = await promisify(run(transaction.objectStore(DOCUMENT_STORE_NAME)))
    return result
  }

  return {
    async put(entry) {
      await tx('readwrite', (store) => store.put(entry))
    },
    get(ref) {
      return tx<StoredDocumentHandle | undefined>('readonly', (store) => store.get(ref))
    },
    async list() {
      const all = await tx<StoredDocumentHandle[]>('readonly', (store) => store.getAll())
      return all.sort((a, b) => b.openedAt - a.openedAt)
    },
    async delete(ref) {
      await tx('readwrite', (store) => store.delete(ref))
    },
  }
}
