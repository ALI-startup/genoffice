/**
 * The file port in a browser (src/renderer/platform-web.ts).
 *
 * The half of the web host that has no counterpart in the operations: opening a deck through
 * the File System Access API, saving it back through the same handle, and reading the one-off
 * files the picker-driven inserts need.
 *
 * The store and the pickers are fakes, so what is under test is this adapter's choices —
 * which store call each member makes, what it reports where the capability is absent, and
 * whether an automatic save can reach a permission prompt. `@genoffice/platform-web`'s own
 * tests cover the store itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankPptx, openPptx, savePptx } from '@genoffice/pptx-engine'
import type { WebDocumentStore } from '@genoffice/platform-web'
import { setSlideRenderEnv } from '../src/domain/session'
import {
  createWebSlidesDocPort,
  createWebSlidesFilePort,
  createWebSlidesPrintPort,
  createWebSlidesWindowPort,
  WebSlidesSession,
  type WebFileServices,
} from '../src/renderer/platform-web'

const FIT = 960
const metrics = {
  metrics: (s: { fontSizePx: number }) => ({
    ascent: s.fontSizePx * 0.8,
    descent: s.fontSizePx * 0.2,
    lineHeight: s.fontSizePx * 1.2,
  }),
  measure: (t: string, s: { fontSizePx: number }) => t.length * s.fontSizePx * 0.5,
}

interface FakeStore {
  store: WebDocumentStore
  files: Map<string, Uint8Array>
  /** Each write, with whether it was allowed to raise a permission prompt. */
  writes: Array<{ ref: string; prompt: boolean }>
  saveAsCalls: string[]
}

function fakeStore(deck: Uint8Array): FakeStore {
  const files = new Map([['ref-1', deck]])
  const writes: FakeStore['writes'] = []
  const saveAsCalls: string[] = []
  const store = {
    open: async () => ({ ref: 'ref-1', name: 'deck.pptx' }),
    reopen: async (ref: string) => ({ ref, name: 'deck.pptx' }),
    read: async (ref: string) => files.get(ref)!,
    recent: async () => [{ ref: 'ref-1', name: 'deck.pptx', openedAt: 1 }],
    write: async (ref: string, bytes: Uint8Array, options?: { prompt?: boolean }) => {
      files.set(ref, bytes)
      writes.push({ ref, prompt: options?.prompt !== false })
    },
    saveAsDocument: async (suggestedName: string, bytes: Uint8Array) => {
      saveAsCalls.push(suggestedName)
      files.set('ref-2', bytes)
      return { ref: 'ref-2', name: suggestedName }
    },
  } as unknown as WebDocumentStore
  return { store, files, writes, saveAsCalls }
}

/** A picker that hands back one file, or reports the dialog was dismissed. */
function fakePickers(file?: { name: string; bytes: Uint8Array }) {
  return {
    openFile: async () => {
      if (!file)
        throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
      return {
        kind: 'file' as const,
        name: file.name,
        queryPermission: async () => 'granted' as const,
        requestPermission: async () => 'granted' as const,
        getFile: async () => ({
          name: file.name,
          size: file.bytes.byteLength,
          lastModified: 1,
          arrayBuffer: async () => file.bytes.buffer.slice(0, file.bytes.byteLength) as ArrayBuffer,
        }),
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      }
    },
    saveFile: async () => {
      throw new Error('the deck dialogs go through the store')
    },
    directory: async () => {
      throw new Error('not used')
    },
  }
}

let deckBytes: Uint8Array
let fake: FakeStore
let slot: WebSlidesSession

const services = (over: Partial<WebFileServices> = {}): WebFileServices => ({
  store: fake.store,
  pickers: fakePickers() as unknown as WebFileServices['pickers'],
  imageSize: async () => ({ width: 200, height: 100 }),
  download: () => {},
  ...over,
})

beforeEach(async () => {
  setSlideRenderEnv({ metrics, decodeTiff: null })
  deckBytes = await savePptx(await openPptx(await createBlankPptx()))
  fake = fakeStore(deckBytes)
  slot = new WebSlidesSession()
})

describe('opening a deck', () => {
  it('adopts the picked handle and reports the name, not the ref', async () => {
    const port = createWebSlidesFilePort(slot, services())

    const result = await port.openPptx(FIT)

    expect(result?.path).toBe('ref-1')
    // What the user sees comes from the host; the ref is not something to show anyone.
    expect(result?.name).toBe('deck.pptx')
    expect(result?.slides.length).toBeGreaterThan(0)
    expect(slot.get()?.path).toBe('ref-1')
  })

  it('reopens by ref, which is how a reload gets its deck back', async () => {
    const port = createWebSlidesFilePort(slot, services())

    const result = await port.openPptxPath('ref-1', FIT)

    expect(result?.path).toBe('ref-1')
  })

  it('has nothing pending, which is what a fresh browser tab is', async () => {
    const port = createWebSlidesFilePort(slot, services())

    await expect(port.consumePendingOpen(FIT)).resolves.toBeNull()
  })

  it('opens a blank deck with no ref and no name', async () => {
    const port = createWebSlidesFilePort(slot, services())

    const result = await port.newBlank(FIT)

    expect(result.path).toBe('')
    expect(result.name).toBe('')
    expect(result.slides.length).toBeGreaterThan(0)
  })

  it('reports no recent files, because a ref is not something to show a user', async () => {
    const port = createWebSlidesFilePort(slot, services())

    await expect(port.getRecentFiles()).resolves.toEqual([])
  })
})

describe('saving', () => {
  it('writes back through the handle the deck was opened from', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)

    const r = await port.save(false)

    expect(r.ok).toBe(true)
    expect(r.name).toBe('deck.pptx')
    expect(fake.writes).toEqual([{ ref: 'ref-1', prompt: true }])
    expect(fake.saveAsCalls).toEqual([])
  })

  it('never lets an automatic save raise a permission prompt', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)

    await port.save(true)

    // `prompt: false` is the whole point: the store then writes only on a standing grant.
    expect(fake.writes).toEqual([{ ref: 'ref-1', prompt: false }])
  })

  it('sends a first manual save through Save As, since a page has no default folder', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.newBlank(FIT)

    const r = await port.save(false)

    expect(fake.saveAsCalls).toEqual(['presentation.pptx'])
    expect(r).toMatchObject({ ok: true, path: 'ref-2', name: 'presentation.pptx' })
  })

  it('declines an automatic first save instead of opening a dialog nobody asked for', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.newBlank(FIT)

    const r = await port.save(true)

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not saved yet/)
    expect(fake.saveAsCalls).toEqual([])
  })

  it('reports no file open rather than throwing', async () => {
    const port = createWebSlidesFilePort(slot, services())

    await expect(port.save(false)).resolves.toEqual({ ok: false, error: 'no file open' })
  })

  it('adopts the Save As destination so later saves land on it', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)

    await port.saveAs('copy.pptx')
    await port.save(false)

    expect(fake.saveAsCalls).toEqual(['copy.pptx'])
    expect(fake.writes.map((w) => w.ref)).toEqual(['ref-2'])
  })
})

describe('the picker-driven inserts', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

  it('inserts a picture at the size the host measured', async () => {
    const imageSize = vi.fn(async () => ({ width: 400, height: 100 }))
    const port = createWebSlidesFilePort(
      slot,
      services({
        pickers: fakePickers({ name: 'shot.png', bytes: png }) as never,
        imageSize,
      }),
    )
    await port.openPptx(FIT)

    const r = await port.insertImage(0, FIT)

    expect(imageSize).toHaveBeenCalled()
    // A 4:1 image, scaled into half the page: wider than tall, and really inserted.
    expect(r && 'sourceId' in r).toBe(true)
  })

  it('reports a dismissed picker as a cancel, not a failure', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)

    await expect(port.insertImage(0, FIT)).resolves.toBeNull()
    await expect(port.insertMedia(0, 'video', FIT)).resolves.toBeNull()
    await expect(port.insertModel3d(0, FIT)).resolves.toBeNull()
    await expect(port.editImageFill({ slideIndex: 0, sourceId: 'x' })).resolves.toBeNull()
  })

  it('cannot fetch an image by url, and says so instead of half-working', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)

    await expect(
      port.insertImageUrl({
        slideIndex: 0,
        url: 'https://example.com/a.png',
        xPx: 0,
        yPx: 0,
        wPx: 10,
        hPx: 10,
        fitWidthPx: FIT,
      }),
    ).resolves.toBeNull()
  })
})

describe('the window port in a page', () => {
  it('answers isDirty from this page, with no host to ask', async () => {
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)
    const win = createWebSlidesWindowPort(
      () => slot.get(),
      () => () => {},
    )

    expect(await win.isDirty()).toBe(false)
    // An edit through the document port is what makes it dirty — same predicate as the desktop.
    const doc = createWebSlidesDocPort(() => slot.get(), {
      commentAuthor: () => 'T',
      translate: (k) => k,
      confirmChartSimplify: async () => true,
    })
    await doc.addElement({
      slideIndex: 0,
      kind: 'textbox',
      xPx: 10,
      yPx: 10,
      wPx: 80,
      hPx: 40,
      fitWidthPx: FIT,
      paragraphs: [{ runs: [{ text: 'dirty now' }] }],
    })

    expect(await win.isDirty()).toBe(true)
  })

  it('arms the browser leave-site prompt, and only while the deck is dirty', async () => {
    let shouldPrompt: (() => boolean) | null = null
    const port = createWebSlidesFilePort(slot, services())
    await port.openPptx(FIT)
    createWebSlidesWindowPort(
      () => slot.get(),
      (predicate) => {
        shouldPrompt = predicate
        return () => {}
      },
    )

    expect(shouldPrompt).not.toBeNull()
    expect(shouldPrompt!()).toBe(false)
    slot.get()!.metaDirty = true
    expect(shouldPrompt!()).toBe(true)
  })

  it('does not pretend the close handshake works, but stays subscribable', () => {
    const win = createWebSlidesWindowPort(
      () => slot.get(),
      () => () => {},
    )

    // A real subscription with no emissions: every caller keeps working, and nothing waits for
    // a save this host could not await during unload.
    expect(typeof win.onCloseSaveRequest(() => {})).toBe('function')
    expect(() => win.reportCloseSaveResult(true)).not.toThrow()
    expect(typeof win.onOpened(() => {})).toBe('function')
  })
})

describe('the print port in a page', () => {
  it('prints the same html the desktop renders, from a frame', async () => {
    const printed: string[] = []
    const print = createWebSlidesPrintPort(async (html) => void printed.push(html))

    const r = await print.printSlides({ pngsBase64: ['AAA'], widthPx: 1600, heightPx: 900 })

    expect(r.ok).toBe(true)
    expect(printed[0]).toContain('data:image/png;base64,AAA')
    // The @page rule is what makes a printout paginate at the slide's own ratio.
    expect(printed[0]).toContain('@page')
  })

  it('reports a failed handover instead of throwing at the caller', async () => {
    const print = createWebSlidesPrintPort(async () => {
      throw new Error('printing is blocked in this frame')
    })

    await expect(print.printSlides({ pngsBase64: [], widthPx: 16, heightPx: 9 })).resolves.toEqual({
      ok: false,
      error: 'printing is blocked in this frame',
    })
  })
})
