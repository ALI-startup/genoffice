/**
 * The document port, backed in a page (src/renderer/platform-web.ts).
 *
 * The claim this file checks is the one phase 7a was for: that a browser can back all 84
 * members of `SlidesDocumentPort` by calling the same operations the main process calls,
 * with no bridge and no second implementation. So it opens a real deck, edits it through
 * the port, and reads the result back through the port.
 *
 * Nothing here mocks `electron`, because nothing on this path touches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankPptx, openPptx, type OpenedPptx } from '@genoffice/pptx-engine'
import { setSlideRenderEnv } from '../src/domain/session'
import {
  createWebSlidesDocPort,
  WebSlidesSession,
  type WebDocumentServices,
} from '../src/renderer/platform-web'

const FIT = 960

/** Deterministic metrics, so a test asserts on layout without depending on installed fonts. */
const metrics = {
  metrics: (style: { fontSizePx: number }) => ({
    ascent: style.fontSizePx * 0.8,
    descent: style.fontSizePx * 0.2,
    lineHeight: style.fontSizePx * 1.2,
  }),
  measure: (text: string, style: { fontSizePx: number }) => text.length * style.fontSizePx * 0.5,
}

let opened: OpenedPptx
let session: WebSlidesSession
let services: WebDocumentServices
let port: ReturnType<typeof createWebSlidesDocPort>

beforeEach(async () => {
  setSlideRenderEnv({ metrics, decodeTiff: null })
  opened = await openPptx(await createBlankPptx())
  session = new WebSlidesSession()
  session.open('handle-1', opened, FIT)
  services = {
    commentAuthor: () => 'Web Tester',
    translate: (key) => key,
    confirmChartSimplify: async () => true,
  }
  port = createWebSlidesDocPort(() => session.get(), services)
})

describe('the document port in a page', () => {
  it('renders the open deck', async () => {
    const slides = await port.getRenderSlides()

    expect(slides).not.toBeNull()
    expect(slides!.length).toBe(opened.deck.slides.length)
    expect(slides![0]!.widthPx).toBeGreaterThan(0)
  })

  it('adds an element and returns the rebuilt page', async () => {
    const added = await port.addElement({
      slideIndex: 0,
      kind: 'textbox',
      xPx: 100,
      yPx: 100,
      wPx: 300,
      hPx: 80,
      fitWidthPx: FIT,
      paragraphs: [{ runs: [{ text: 'From the page' }] }],
    })

    expect(added?.sourceId).toBeTruthy()
    // The edit landed in the document this page holds, not in some other process's copy.
    const texts = opened.deck.slides[0]!.elements.flatMap((el) =>
      'text' in el && el.text ? el.text.paragraphs.flatMap((p) => p.runs.map((r) => r.text)) : [],
    )
    expect(texts).toContain('From the page')
  })

  it("undoes it, because the history is the session's and the session is here", async () => {
    const before = opened.deck.slides[0]!.elements.length
    await port.addElement({
      slideIndex: 0,
      kind: 'textbox',
      xPx: 10,
      yPx: 10,
      wPx: 100,
      hPx: 50,
      fitWidthPx: FIT,
      paragraphs: [{ runs: [{ text: 'x' }] }],
    })
    expect(opened.deck.slides[0]!.elements.length).toBe(before + 1)

    await port.undo()

    expect(opened.deck.slides[0]!.elements.length).toBe(before)
  })

  it('adds a slide and reports the whole deck back', async () => {
    const result = await port.addBlankSlide({ sourceIndex: 0, fitWidthPx: FIT })

    expect(result).not.toBeNull()
    expect(opened.deck.slides.length).toBe(2)
  })

  it('attributes a comment to the author the host supplies, not to a hardcoded name', async () => {
    const author = vi.fn(() => 'Someone Else')
    const withAuthor = createWebSlidesDocPort(() => session.get(), {
      ...services,
      commentAuthor: author,
    })

    await withAuthor.addComment({ slideIndex: 0, text: 'looks good' })

    expect(author).toHaveBeenCalled()
    const comments = await withAuthor.getComments(0)
    expect(comments.map((c) => c.author)).toContain('Someone Else')
  })

  it('labels animation targets through the host translator', async () => {
    const translate = vi.fn((key: string) => `T:${key}`)
    const withTranslate = createWebSlidesDocPort(() => session.get(), { ...services, translate })

    await withTranslate.getAnimations(0)

    // Called even on a deck with no animations: the labels are built for the pane's list.
    expect(translate).toHaveBeenCalled()
  })

  it('reports null for every member before a deck is open, rather than throwing', async () => {
    const empty = createWebSlidesDocPort(() => undefined, services)

    expect(await empty.getRenderSlides()).toBeNull()
    expect(await empty.getSlideSize()).toBeNull()
    expect(await empty.undo()).toBeNull()
  })
})
