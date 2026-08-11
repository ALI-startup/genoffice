import { beforeEach, describe, expect, it } from 'vitest'
import { DOCX_FILE_TYPES, FilePermissionDeniedError, PDF_FILE_TYPES } from '../src/fs-access'
import { UnknownDocumentError, WebDocumentStore } from '../src/document-store'
import {
  fakeDirectoryHandle,
  fakeFileHandle,
  fakeHandleStore,
  fakePickers,
  pickerCancel,
  type FakePickers,
} from './fakes'
import type { DocumentHandleStore, StoredDocumentHandle } from '../src/handle-store'

let handles: DocumentHandleStore & { entries: Map<string, StoredDocumentHandle> }
let pickers: FakePickers
let refs: number

const newStore = () => {
  refs = 0
  return new WebDocumentStore({
    handles,
    pickers,
    newRef: () => `ref-${++refs}`,
    now: () => 1_000 + refs,
  })
}

beforeEach(() => {
  handles = fakeHandleStore()
  pickers = fakePickers()
  refs = 0
})

describe('open', () => {
  it('mints an opaque ref, keeps the handle and reports the file name', async () => {
    const store = newStore()
    pickers.openQueue.push(fakeFileHandle('report.pdf'))

    const doc = await store.open()

    expect(doc).toEqual({ ref: 'ref-1', name: 'report.pdf' })
    // No path is invented anywhere: the ref is opaque and `location` is simply absent.
    expect(doc!.ref).not.toContain('report.pdf')
  })

  it('persists the handle itself so recent files survive a reload', async () => {
    const store = newStore()
    const handle = fakeFileHandle('report.pdf')
    pickers.openQueue.push(handle)

    const doc = await store.open()

    expect(handles.entries.get(doc!.ref)?.handle).toBe(handle)
    await expect(store.recent()).resolves.toEqual([
      { ref: 'ref-1', name: 'report.pdf', openedAt: 1_001 },
    ])
  })

  it('returns null when the user dismisses the dialog', async () => {
    const store = newStore()
    pickers.openQueue.push(pickerCancel())

    await expect(store.open()).resolves.toBeNull()
    expect(handles.entries.size).toBe(0)
  })

  it('propagates a real picker failure instead of swallowing it as a cancel', async () => {
    const store = newStore()
    pickers.openQueue.push(new Error('picker exploded'))

    await expect(store.open()).rejects.toThrow('picker exploded')
  })
})

describe('read and write', () => {
  it('reads the current bytes through the handle', async () => {
    const store = newStore()
    pickers.openQueue.push(fakeFileHandle('a.pdf', new Uint8Array([1, 2, 3])))
    const doc = await store.open()

    await expect(store.read(doc!.ref)).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it('writes back into the same file, which is what save-in-place means', async () => {
    const store = newStore()
    const handle = fakeFileHandle('a.pdf', new Uint8Array([1, 2, 3]))
    pickers.openQueue.push(handle)
    const doc = await store.open()

    await store.write(doc!.ref, new Uint8Array([9, 9]))

    expect(handle.contents).toEqual(new Uint8Array([9, 9]))
  })

  it('exposes the PdfBytesIo pair @genoffice/pdf-edit savePdf drives', async () => {
    const store = newStore()
    const handle = fakeFileHandle('a.pdf', new Uint8Array([1, 2, 3]))
    pickers.openQueue.push(handle)
    const doc = await store.open()

    // savePdf is read → apply edits → write; assert both halves are bound to
    // the same handle, which is what makes the edited bytes land in the
    // original file instead of a download.
    const io = store.bytesIo(doc!.ref)
    await expect(io.read()).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await io.write(new Uint8Array([7]))
    expect(handle.contents).toEqual(new Uint8Array([7]))
    await expect(io.read()).resolves.toEqual(new Uint8Array([7]))
  })

  it('rejects a ref it never issued', async () => {
    const store = newStore()

    await expect(store.read('not-a-ref')).rejects.toThrow(UnknownDocumentError)
  })
})

describe('reuse of a persisted handle', () => {
  /** Model a page reload: a brand-new store over the same persisted entries. */
  const afterReload = () => new WebDocumentStore({ handles, pickers, newRef: () => 'unused' })

  it('queries readwrite permission before touching the file', async () => {
    const first = newStore()
    const handle = fakeFileHandle('a.pdf', new Uint8Array([4]))
    pickers.openQueue.push(handle)
    const doc = await first.open()
    handle.permissions.queried.length = 0

    await expect(afterReload().read(doc!.ref)).resolves.toEqual(new Uint8Array([4]))

    expect(handle.permissions.queried).toEqual([{ mode: 'readwrite' }])
    expect(handle.permissions.requested).toEqual([])
  })

  it('re-requests permission when the browser has dropped it', async () => {
    const first = newStore()
    const handle = fakeFileHandle('a.pdf', new Uint8Array([4]))
    pickers.openQueue.push(handle)
    const doc = await first.open()
    // Across a reload the browser answers 'prompt' until the user re-grants.
    handle.queryState = 'prompt'
    handle.requestState = 'granted'

    await expect(afterReload().read(doc!.ref)).resolves.toEqual(new Uint8Array([4]))

    expect(handle.permissions.requested).toEqual([{ mode: 'readwrite' }])
  })

  it('fails loudly when permission is denied, and does not write', async () => {
    const first = newStore()
    const handle = fakeFileHandle('a.pdf', new Uint8Array([4]))
    pickers.openQueue.push(handle)
    const doc = await first.open()
    handle.queryState = 'prompt'
    handle.requestState = 'denied'

    const reloaded = afterReload()
    await expect(reloaded.read(doc!.ref)).rejects.toThrow(FilePermissionDeniedError)
    await expect(reloaded.write(doc!.ref, new Uint8Array([1]))).rejects.toThrow(
      /Permission to edit "a\.pdf" was not granted/,
    )
    // The critical assertion: a denied grant leaves the file untouched rather
    // than reporting a save that never happened.
    expect(handle.contents).toEqual(new Uint8Array([4]))
  })

  it('reopen surfaces the same denial rather than returning a dead document', async () => {
    const first = newStore()
    const handle = fakeFileHandle('a.pdf')
    pickers.openQueue.push(handle)
    const doc = await first.open()
    handle.queryState = 'prompt'
    handle.requestState = 'denied'

    await expect(afterReload().reopen(doc!.ref)).rejects.toThrow(FilePermissionDeniedError)
  })

  it('reopen refreshes the recent-list timestamp on success', async () => {
    const first = newStore()
    pickers.openQueue.push(fakeFileHandle('a.pdf'))
    const doc = await first.open()

    const reloaded = new WebDocumentStore({
      handles,
      pickers,
      newRef: () => 'unused',
      now: () => 5_000,
    })
    await expect(reloaded.reopen(doc!.ref)).resolves.toEqual({ ref: 'ref-1', name: 'a.pdf' })
    await expect(reloaded.recent()).resolves.toEqual([
      { ref: 'ref-1', name: 'a.pdf', openedAt: 5_000 },
    ])
  })

  it('reopen rejects a ref the browser no longer has a handle for', async () => {
    await expect(newStore().reopen('gone')).rejects.toThrow(UnknownDocumentError)
  })
})

describe('recent list', () => {
  it('orders by most recently opened and forgets on request', async () => {
    const store = newStore()
    pickers.openQueue.push(fakeFileHandle('one.pdf'), fakeFileHandle('two.pdf'))
    const first = await store.open()
    const second = await store.open()

    await expect(store.recent()).resolves.toEqual([
      { ref: second!.ref, name: 'two.pdf', openedAt: 1_002 },
      { ref: first!.ref, name: 'one.pdf', openedAt: 1_001 },
    ])

    await store.forget(first!.ref)
    await expect(store.recent()).resolves.toEqual([
      { ref: second!.ref, name: 'two.pdf', openedAt: 1_002 },
    ])
    await expect(store.read(first!.ref)).rejects.toThrow(UnknownDocumentError)
  })

  it('keeps the document usable when persistence fails', async () => {
    const failing = {
      ...fakeHandleStore(),
      put: () => Promise.reject(new Error('IndexedDB unavailable')),
    }
    const store = new WebDocumentStore({ handles: failing, pickers, newRef: () => 'ref-1' })
    pickers.openQueue.push(fakeFileHandle('a.pdf', new Uint8Array([5])))

    const doc = await store.open()

    expect(doc).not.toBeNull()
    await expect(store.read(doc!.ref)).resolves.toEqual(new Uint8Array([5]))
  })
})

describe('one-off host dialogs', () => {
  it('pickBytes reads a file without adding it to the recent list', async () => {
    const store = newStore()
    pickers.openQueue.push(fakeFileHandle('other.pdf', new Uint8Array([8])))

    await expect(store.pickBytes()).resolves.toEqual(new Uint8Array([8]))
    await expect(store.recent()).resolves.toEqual([])
  })

  it('saveBytesAs writes to the picked destination and reports its name', async () => {
    const store = newStore()
    const target = fakeFileHandle('copy.pdf')
    pickers.saveQueue.push(target)

    await expect(store.saveBytesAs('copy.pdf', new Uint8Array([1, 2]))).resolves.toBe('copy.pdf')
    expect(target.contents).toEqual(new Uint8Array([1, 2]))
  })

  it('pickDirectory writes files into the chosen folder', async () => {
    const store = newStore()
    const dir = fakeDirectoryHandle('exports')
    pickers.directoryQueue.push(dir)

    const picked = await store.pickDirectory()
    await picked!.writeFile('page-1.png', new Uint8Array([3]))

    expect(dir.files.get('page-1.png')?.contents).toEqual(new Uint8Array([3]))
  })

  it('reports cancel as null for every dialog', async () => {
    const store = newStore()
    pickers.openQueue.push(pickerCancel())
    pickers.saveQueue.push(pickerCancel())
    pickers.directoryQueue.push(pickerCancel())

    await expect(store.pickBytes()).resolves.toBeNull()
    await expect(store.saveBytesAs('x.pdf', new Uint8Array())).resolves.toBeNull()
    await expect(store.pickDirectory()).resolves.toBeNull()
  })

  it('announces dialog open/close so the app can pause autosave', async () => {
    const store = newStore()
    const seen: boolean[] = []
    const off = store.onDialog((open) => seen.push(open))
    pickers.openQueue.push(fakeFileHandle('a.pdf'))

    await store.open()
    expect(seen).toEqual([true, false])

    off()
    pickers.openQueue.push(fakeFileHandle('b.pdf'))
    await store.open()
    expect(seen).toEqual([true, false])
  })

  it('announces close even when the dialog is dismissed', async () => {
    const store = newStore()
    const seen: boolean[] = []
    store.onDialog((open) => seen.push(open))
    pickers.openQueue.push(pickerCancel())

    await store.open()
    expect(seen).toEqual([true, false])
  })
})

describe('saveAsDocument', () => {
  it('writes the bytes and adopts the destination, so later saves land on it', async () => {
    const store = newStore()
    const destination = fakeFileHandle('copy.pdf')
    pickers.saveQueue.push(destination)

    const saved = await store.saveAsDocument('copy.pdf', new Uint8Array([1, 2, 3]))

    expect(saved).toEqual({ ref: 'ref-1', name: 'copy.pdf' })
    expect([...destination.contents]).toEqual([1, 2, 3])
    // Adopted, not just written: the ref resolves, which is the difference from
    // saveBytesAs and the reason Save As can be followed by an in-place save.
    await store.write(saved!.ref, new Uint8Array([9]))
    expect([...destination.contents]).toEqual([9])
    // And it is in the recent list, because the user really did open it.
    await expect(store.recent()).resolves.toEqual([
      { ref: 'ref-1', name: 'copy.pdf', openedAt: 1_001 },
    ])
  })

  it('reports a dismissed dialog as null, not as a failure', async () => {
    const store = newStore()
    pickers.saveQueue.push(pickerCancel())

    await expect(store.saveAsDocument('copy.pdf', new Uint8Array([1]))).resolves.toBeNull()
    await expect(store.recent()).resolves.toEqual([])
  })

  it('refuses to write when write permission is denied, and mints no ref', async () => {
    const store = newStore()
    const destination = fakeFileHandle('copy.pdf')
    destination.queryState = 'prompt'
    destination.requestState = 'denied'
    pickers.saveQueue.push(destination)

    await expect(store.saveAsDocument('copy.pdf', new Uint8Array([1]))).rejects.toBeInstanceOf(
      FilePermissionDeniedError,
    )
    await expect(store.recent()).resolves.toEqual([])
  })
})

describe('file types', () => {
  it('defaults every dialog to PDF, keeping the first caller unchanged', async () => {
    const store = newStore()
    const seen: unknown[] = []
    pickers.openFile = (options) => {
      seen.push(options)
      return Promise.resolve(fakeFileHandle('a.pdf'))
    }

    await store.open()
    expect(seen).toEqual([{ types: PDF_FILE_TYPES, id: 'genoffice-pdf' }])
  })

  it('filters and groups dialogs by the configured format, which is how docs gets .docx', async () => {
    const store = new WebDocumentStore({
      handles,
      pickers,
      fileTypes: DOCX_FILE_TYPES,
      pickerId: 'genoffice-docx',
      newRef: () => 'ref-1',
      now: () => 1_000,
    })
    const seen: unknown[] = []
    pickers.openFile = (options) => {
      seen.push(options)
      return Promise.resolve(fakeFileHandle('report.docx'))
    }
    pickers.saveFile = (options) => {
      seen.push(options)
      return Promise.resolve(fakeFileHandle('copy.docx'))
    }

    await store.open()
    await store.saveBytesAs('copy.docx', new Uint8Array([1]))

    expect(seen).toEqual([
      { types: DOCX_FILE_TYPES, id: 'genoffice-docx' },
      { types: DOCX_FILE_TYPES, suggestedName: 'copy.docx', id: 'genoffice-docx' },
    ])
  })
})

describe('stat', () => {
  it('reports last-modified and size — the browser half of DiskFileState', async () => {
    const store = newStore()
    const handle = fakeFileHandle('report.pdf', new Uint8Array([1, 2, 3]))
    handle.lastModified = 12_345
    pickers.openQueue.push(handle)
    const doc = await store.open()

    await expect(store.stat(doc!.ref)).resolves.toEqual({ lastModified: 12_345, size: 3 })
  })

  it('does not read the file, which is what keeps the no-conflict save path cheap', async () => {
    const store = newStore()
    const handle = fakeFileHandle('report.pdf', new Uint8Array([1, 2, 3]))
    let reads = 0
    const realGetFile = handle.getFile.bind(handle)
    handle.getFile = async () => {
      const file = await realGetFile()
      return {
        ...file,
        arrayBuffer: () => {
          reads++
          return file.arrayBuffer()
        },
      }
    }
    pickers.openQueue.push(handle)
    const doc = await store.open()

    await store.stat(doc!.ref)
    expect(reads).toBe(0)
  })

  it('rejects for a ref it never issued, so a caller cannot mistake it for "unchanged"', async () => {
    await expect(newStore().stat('nope')).rejects.toBeInstanceOf(UnknownDocumentError)
  })
})
