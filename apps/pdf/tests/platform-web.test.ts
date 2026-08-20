/** The browser host adapter (src/renderer/platform-web.ts). */
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import type { WebDocumentStore } from '@samugen/platform-web'
import { createWebPdfFilePort, createWebPdfWindowPort } from '../src/renderer/platform-web'
import type { PdfEditRequest } from '../src/shared/ipc'

/** The empty edit payload; individual tests override only what they exercise. */
const noEdits: PdfEditRequest = {
  markups: [],
  drawings: [],
  stamps: [],
  formValues: [],
}

/**
 * A real two-page PDF. The adapter runs @samugen/pdf-edit for real rather than against a mock, so
 * the store's bytes have to be a document pdf-lib can load — which also means the "nothing is
 * written when the edit fails" test can use deliberate garbage and mean it.
 */
async function makePdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([200, 300])
  return doc.save({ useObjectStreams: false })
}

const PDF_BYTES = await makePdf()

interface FakeStore {
  store: WebDocumentStore
  /** ref → current bytes, so a save is observable as a byte change. */
  files: Map<string, Uint8Array>
  writes: Array<{ ref: string; size: number }>
  dirWrites: Array<{ name: string; bytes: Uint8Array }>
  dialogs: Array<(open: boolean) => void>
}

function fakeStore(
  overrides: Partial<Record<keyof WebDocumentStore, unknown>> = {},
  initial: Array<[string, Uint8Array]> = [['doc-1', PDF_BYTES]],
): FakeStore {
  const files = new Map(initial)
  const writes: FakeStore['writes'] = []
  const dirWrites: FakeStore['dirWrites'] = []
  const dialogs: FakeStore['dialogs'] = []
  const read = (ref: string) => {
    const bytes = files.get(ref)
    if (!bytes) throw new Error(`no such ref: ${ref}`)
    return Promise.resolve(bytes)
  }
  const write = (ref: string, bytes: Uint8Array) => {
    files.set(ref, bytes)
    writes.push({ ref, size: bytes.byteLength })
    return Promise.resolve()
  }
  const base = {
    open: () => Promise.resolve(null),
    read,
    write,
    pickBytes: () => Promise.resolve(null),
    saveBytesAs: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    onDialog: (handler: (open: boolean) => void) => {
      dialogs.push(handler)
      return () => void dialogs.splice(dialogs.indexOf(handler), 1)
    },
    ...overrides,
  } as Record<string, unknown>
  // Defined after the overrides and routed through them, exactly as the real `bytesIo` routes
  // through `this.read` / `this.write`.
  base.bytesIo ??= (ref: string) => ({
    read: () => (base.read as typeof read)(ref),
    write: (bytes: Uint8Array) => (base.write as typeof write)(ref, bytes),
  })
  return { store: base as unknown as WebDocumentStore, files, writes, dirWrites, dialogs }
}

describe('consumePending', () => {
  it('is always null, which is what makes the empty state reachable', async () => {
    const { store } = fakeStore()
    await expect(createWebPdfFilePort(store).consumePending()).resolves.toBeNull()
  })
})

describe('openDocument', () => {
  it('adopts the picked document and reports no location', async () => {
    const { store } = fakeStore({
      open: () => Promise.resolve({ ref: 'doc-9', name: 'report.pdf' }),
    })
    const opened = await createWebPdfFilePort(store).openDocument?.()
    // No `location`: a File System Access handle has no path, and inventing one
    // would put a fiction in the title-bar tooltip.
    expect(opened).toEqual({ ref: 'doc-9', name: 'report.pdf' })
    expect(opened && 'location' in opened).toBe(false)
  })

  it('returns null when the user dismisses the dialog', async () => {
    const { store } = fakeStore({ open: () => Promise.resolve(null) })
    await expect(createWebPdfFilePort(store).openDocument?.()).resolves.toBeNull()
  })

  it('is present on this host, unlike the Electron one', () => {
    expect(createWebPdfFilePort(fakeStore().store).openDocument).toBeTypeOf('function')
  })
})

describe('readFile', () => {
  it('hands back the document bytes as an ArrayBuffer', async () => {
    const { store } = fakeStore({}, [['doc-1', new Uint8Array([7, 8, 9])]])
    const buffer = await createWebPdfFilePort(store).readFile('doc-1')
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(buffer)]).toEqual([7, 8, 9])
  })

  it('lets an unknown ref reject, since the renderer already catches it', async () => {
    const { store } = fakeStore()
    await expect(createWebPdfFilePort(store).readFile('nope')).rejects.toThrow('no such ref')
  })
})

describe('save', () => {
  it('writes an edited document back in place when there is no Save As target', async () => {
    const { store, writes, files } = fakeStore()
    const result = await createWebPdfFilePort(store).save({
      ref: 'doc-1',
      ...noEdits,
      rotations: [{ pageIndex: 0, delta: 90 }],
    })
    expect(result).toEqual({ ok: true })
    expect(writes.map((w) => w.ref)).toEqual(['doc-1'])
    // The edit really ran: the rotation is in the bytes now held for the ref.
    const reloaded = await PDFDocument.load(files.get('doc-1')!)
    expect(reloaded.getPage(0).getRotation().angle).toBe(90)
  })

  it('reads the source and writes only the target for Save As', async () => {
    const { store, writes, files } = fakeStore({}, [
      ['doc-1', PDF_BYTES],
      ['copy-1', PDF_BYTES],
    ])
    const result = await createWebPdfFilePort(store).save({
      ref: 'doc-1',
      target: 'copy-1',
      ...noEdits,
      rotations: [{ pageIndex: 0, delta: 90 }],
    })
    expect(result).toEqual({ ok: true })
    // The decisive assertion: the open document was not touched.
    expect(writes.map((w) => w.ref)).toEqual(['copy-1'])
    expect(files.get('doc-1')).toBe(PDF_BYTES)
    expect((await PDFDocument.load(files.get('copy-1')!)).getPage(0).getRotation().angle).toBe(90)
  })

  it('reports a write failure as ok:false rather than throwing at the renderer', async () => {
    const { store } = fakeStore({
      write: () => Promise.reject(new Error('permission was not granted')),
    })
    const result = await createWebPdfFilePort(store).save({ ref: 'doc-1', ...noEdits })
    expect(result).toEqual({ ok: false, error: 'permission was not granted' })
  })

  it('does not write when the edit itself fails', async () => {
    const { store, writes } = fakeStore({}, [['doc-1', new Uint8Array([9, 9, 9])]])
    // Not a PDF: pdf-lib rejects on load, before anything is written.
    const result = await createWebPdfFilePort(store).save({ ref: 'doc-1', ...noEdits })
    expect(result.ok).toBe(false)
    expect(writes).toEqual([])
  })
})

describe('extractPages', () => {
  it('reports a dismissed save dialog as canceled, not as an error', async () => {
    const { store } = fakeStore({ saveBytesAs: () => Promise.resolve(null) })
    const result = await createWebPdfFilePort(store).extractPages({
      ref: 'doc-1',
      pages: [0],
      suggestedName: 'out.pdf',
    })
    expect(result).toEqual({ ok: true, canceled: true })
  })

  it('writes the extracted pages and reports the name the user picked', async () => {
    let extracted: Uint8Array | undefined
    const { store, writes } = fakeStore({
      saveBytesAs: (_name: string, bytes: Uint8Array) => {
        extracted = bytes
        return Promise.resolve('page-1.pdf')
      },
    })
    const result = await createWebPdfFilePort(store).extractPages({
      ref: 'doc-1',
      pages: [1],
      suggestedName: 'out.pdf',
    })
    // `savedPath` carries a name, not a path: a browser has no path to give.
    expect(result).toEqual({ ok: true, savedPath: 'page-1.pdf' })
    expect((await PDFDocument.load(extracted!)).getPageCount()).toBe(1)
    // The source document is untouched by an extract.
    expect(writes).toEqual([])
  })
})

describe('insertPdf', () => {
  it('reports a dismissed picker as canceled and writes nothing', async () => {
    const { store, writes } = fakeStore({ pickBytes: () => Promise.resolve(null) })
    const result = await createWebPdfFilePort(store).insertPdf({
      ref: 'doc-1',
      afterPageIndex: 0,
    })
    expect(result).toEqual({ ok: true, canceled: true })
    expect(writes).toEqual([])
  })

  it('merges the picked document in and writes the result back immediately', async () => {
    const { store, writes, files } = fakeStore({ pickBytes: () => makePdf(3) })
    const result = await createWebPdfFilePort(store).insertPdf({
      ref: 'doc-1',
      afterPageIndex: 0,
    })
    expect(result).toEqual({ ok: true, insertedCount: 3 })
    expect(writes.map((w) => w.ref)).toEqual(['doc-1'])
    expect((await PDFDocument.load(files.get('doc-1')!)).getPageCount()).toBe(5)
  })
})

describe('exportImages', () => {
  it('reports a dismissed directory picker as canceled', async () => {
    const { store } = fakeStore({ pickDirectory: () => Promise.resolve(null) })
    const result = await createWebPdfFilePort(store).exportImages({
      images: ['AAAA'],
      pageNumbers: [1],
      baseName: 'doc',
    })
    expect(result).toEqual({ ok: true, canceled: true })
  })

  it('decodes each base64 PNG and names it by page number', async () => {
    const written: Array<{ name: string; bytes: number[] }> = []
    const { store } = fakeStore({
      pickDirectory: () =>
        Promise.resolve({
          name: 'Exports',
          writeFile: (name: string, bytes: Uint8Array) => {
            written.push({ name, bytes: [...bytes] })
            return Promise.resolve()
          },
        }),
    })
    const result = await createWebPdfFilePort(store).exportImages({
      // btoa('ab') === 'YWI=', btoa('cd') === 'Y2Q='
      images: ['YWI=', 'Y2Q='],
      pageNumbers: [3, 4],
      baseName: 'report',
    })
    expect(result).toEqual({ ok: true, savedDir: 'Exports', count: 2 })
    expect(written).toEqual([
      { name: 'report-3.png', bytes: [97, 98] },
      { name: 'report-4.png', bytes: [99, 100] },
    ])
  })

  it('reports a directory write failure as ok:false', async () => {
    const { store } = fakeStore({
      pickDirectory: () =>
        Promise.resolve({
          name: 'Exports',
          writeFile: () => Promise.reject(new Error('disk full')),
        }),
    })
    const result = await createWebPdfFilePort(store).exportImages({
      images: ['YWI='],
      pageNumbers: [1],
      baseName: 'report',
    })
    expect(result).toEqual({ ok: false, error: 'disk full' })
  })
})

describe('window port', () => {
  const slice = {
    setDirty: vi.fn(),
    onCloseSaveRequest: () => () => {},
    reportCloseSaveResult: () => {},
  }

  it('pauses autosave for every host dialog, not just Save As', () => {
    // The Electron source is the shell's Save As flow; the browser's is every
    // picker, because every picker blurs the window and a blur triggers autosave.
    const { store, dialogs } = fakeStore()
    const seen: boolean[] = []
    const off = createWebPdfWindowPort(slice, store).onSaveAsFlow((inFlight) => seen.push(inFlight))
    expect(dialogs.length).toBe(1)
    dialogs[0]?.(true)
    dialogs[0]?.(false)
    expect(seen).toEqual([true, false])
    off()
    expect(dialogs.length).toBe(0)
  })

  it('accepts a Save As subscription that it never calls back', () => {
    const { store } = fakeStore()
    const handler = vi.fn()
    const off = createWebPdfWindowPort(slice, store).onSaveAsRequest(handler)
    expect(handler).not.toHaveBeenCalled()
    // Unsubscribing must still be safe; there is simply nothing to remove.
    expect(off).toBeTypeOf('function')
    off()
  })

  it('warns instead of silently swallowing a Save As reply nobody asked for', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createWebPdfWindowPort(slice, fakeStore().store).reportSaveAsResult(true)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('never issues a Save As request')
    warn.mockRestore()
  })

  it('passes the dirty-state slice straight through', () => {
    createWebPdfWindowPort(slice, fakeStore().store).setDirty(true)
    expect(slice.setDirty).toHaveBeenCalledWith(true)
  })
})
