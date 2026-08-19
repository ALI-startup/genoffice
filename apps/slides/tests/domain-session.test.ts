/**
 * The document session, exercised without Electron (src/domain/session.ts).
 *
 * Two properties are worth pinning down, and neither was covered before the module
 * was split out: that the session's rendering services are genuinely injected — so
 * a browser host can supply its own — and that a host which forgets to install them
 * fails loudly instead of producing blank slides.
 *
 * The import is `../src/domain/session`, not `../src/main/session-state`, and that is
 * the point of the file: nothing here mocks `electron`, because nothing in the path
 * touches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankPptx, openPptx, utf8Bytes, type OpenedPptx } from '@samugen/pptx-engine'
import {
  buildAllRenderSlides,
  makeMediaResolver,
  pushHistory,
  rebuildSlide,
  setSlideRenderEnv,
  type Session,
} from '../src/domain/session'

/** Deterministic stand-in for the host's font metrics: every glyph half an em wide. */
const fakeMetrics = {
  metrics: (style: { fontSizePx: number }) => ({
    ascent: style.fontSizePx * 0.8,
    descent: style.fontSizePx * 0.2,
    lineHeight: style.fontSizePx * 1.2,
  }),
  measure: (text: string, style: { fontSizePx: number }) => text.length * style.fontSizePx * 0.5,
}

function sessionFor(opened: OpenedPptx): Session {
  return { path: '', opened, fitWidthPx: 960, undoStack: [], redoStack: [] }
}

let opened: OpenedPptx

beforeEach(async () => {
  opened = await openPptx(await createBlankPptx())
  setSlideRenderEnv({ metrics: fakeMetrics, decodeTiff: null })
})

describe('the injected render env', () => {
  it('builds a RenderSlide per slide from the host metrics', () => {
    const slides = buildAllRenderSlides(opened, 960)

    expect(slides.length).toBe(opened.deck.slides.length)
    expect(slides[0]!.widthPx).toBeGreaterThan(0)
  })

  it('refuses to render at all when a host forgot to install its services', async () => {
    // A fresh module instance, so the slot is genuinely unset — the failure mode this
    // guards is a host that renders blank slides instead of saying anything. The
    // statically imported copy above keeps the env this file installed.
    vi.resetModules()
    const fresh = await import('../src/domain/session')

    expect(() => fresh.buildAllRenderSlides(opened, 960)).toThrow(/render env not installed/)
  })

  it('rebuilds one slide, which is what an edit sends back to the renderer', () => {
    const session = sessionFor(opened)

    expect(rebuildSlide(session, 0)).not.toBeNull()
    expect(rebuildSlide(session, 99)).toBeNull()
  })
})

describe('the media resolver', () => {
  it('serves an image part as a data url', () => {
    opened.archive.entries.set('ppt/media/image1.png', utf8Bytes('not-really-a-png'))

    const url = makeMediaResolver(opened)('ppt/media/image1.png')

    expect(url).toMatch(/^data:image\/png;base64,/)
    // Round-trips through the engine's base64, not Buffer: this is the line a
    // browser would otherwise die on.
    expect(atob(url!.split(',')[1]!)).toBe('not-really-a-png')
  })

  it('reports a jpeg as a jpeg, since the mime comes from the part name', () => {
    opened.archive.entries.set('ppt/media/image2.jpeg', utf8Bytes('x'))

    expect(makeMediaResolver(opened)('ppt/media/image2.jpeg')).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('skips a tiff on a host with no decoder rather than serving bytes Chromium cannot read', () => {
    opened.archive.entries.set('ppt/media/image3.tif', utf8Bytes('II*'))

    expect(makeMediaResolver(opened)('ppt/media/image3.tif')).toBeUndefined()
  })

  it('uses the host decoder for a tiff when there is one', () => {
    setSlideRenderEnv({
      metrics: fakeMetrics,
      decodeTiff: () => ({ png: utf8Bytes('decoded') }),
    })
    opened.archive.entries.set('ppt/media/image4.tiff', utf8Bytes('II*'))

    const url = makeMediaResolver(opened)('ppt/media/image4.tiff')

    expect(url).toMatch(/^data:image\/png;base64,/)
    expect(atob(url!.split(',')[1]!)).toBe('decoded')
  })

  it('reads each part once, because a deck reuses the same picture across slides', () => {
    let reads = 0
    const counted = {
      ...opened,
      archive: Object.create(opened.archive, {
        readBytes: {
          value: (path: string) => {
            reads++
            return opened.archive.readBytes(path)
          },
        },
      }) as OpenedPptx['archive'],
    }
    counted.archive.entries.set('ppt/media/image5.png', utf8Bytes('x'))
    const resolve = makeMediaResolver(counted)

    resolve('ppt/media/image5.png')
    resolve('ppt/media/image5.png')

    expect(reads).toBe(1)
  })
})

describe('history over the session', () => {
  it('snapshots the deck before an edit, independently of any host', () => {
    const session = sessionFor(opened)
    const before = session.opened.deck.slides[0]!.elements.length

    pushHistory(session)
    session.opened.deck.slides[0]!.elements = []

    expect(session.undoStack.length).toBe(1)
    expect(session.undoStack[0]!.slides[0]!.elements.length).toBe(before)
  })
})
