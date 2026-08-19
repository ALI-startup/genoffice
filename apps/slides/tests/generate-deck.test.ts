/**
 * generate_deck / regenerate_slide end to end, with a fake model and a fake host.
 *
 * The pipeline is: the model writes a PageSpec (content + a layout name), `composePage`
 * decides the geometry, and the skill lands the result as real elements through the doc
 * port. `deck-compose.test.ts` covers the middle step in isolation; this drives the whole
 * loop, so it is where the properties that only exist across the steps are asserted:
 * every planned page gets a page, a page that fails does not take the run down with it,
 * a dead image degrades to a page without the picture, and "replace" really replaces.
 *
 * The host is faked at the platform slot rather than at `DeckAccess`, because landing a
 * page calls `slidesDoc()` / `slidesFile()` directly. The fake keeps one deck array as its
 * source of truth, exactly as the main process does, so the skill's applyDeck/applySlide
 * plumbing is exercised too.
 */
import { describe, it, expect } from 'vitest'
import type { RenderNode, RenderSlide, PlacedBox } from '@samugen/pptx-render'
import {
  createSlidesSkill,
  type DeckAccess,
  type DeckProgressEvent,
} from '../src/renderer/ai/slides-skill'
import type { PageSpec } from '../src/renderer/ai/deck-compose'
import type {
  AddElementOp,
  DeleteElementOp,
  EditBackgroundOp,
  AgentToolCall,
} from '../src/shared/ipc'
import { installTestPlatform } from './helpers/platform'

const box = (x: number, y: number, w: number, h: number): PlacedBox => ({
  x,
  y,
  w,
  h,
  rotationDeg: 0,
  flipH: false,
  flipV: false,
  centerX: x + w / 2,
  centerY: y + h / 2,
})

const node = (id: string, b = box(0, 0, 100, 100)): RenderNode =>
  ({ id, sourceId: id, type: 'shape', box: b, fill: { kind: 'none' } }) as RenderNode

const slideOf = (nodes: RenderNode[]): RenderSlide => ({
  widthPx: 960,
  heightPx: 540,
  scale: 1,
  background: { kind: 'solid', color: '#ffffff' },
  nodes,
})

const STYLE_SKILL = [
  'Main background: #0f1b2d',
  'Primary accent: #ffb703',
  'Title font: Poppins',
  'Body font: Inter',
].join('\n')

type WriteArgs = Parameters<NonNullable<DeckAccess['writePageSpec']>>[0]

const contentSpec = (title: string): PageSpec => ({
  layout: 'title_bullets',
  blocks: [
    { kind: 'title', text: title },
    { kind: 'bullets', items: ['first point', 'second point', 'third point'] },
  ],
})

interface HarnessOptions {
  /** Pages the deck already holds before the run (each with one existing element). */
  initialPages?: number
  /** Per-page model behaviour, keyed by the brief the planner produced. */
  writePageSpec?: (args: WriteArgs) => { ok: boolean; spec?: unknown; error?: string }
  /** Image URLs `searchImages` hands back; [] models a search that found nothing. */
  imageUrls?: string[]
  /** Layout the planner asks for (drives whether pages want a picture at all). */
  planLayout?: string
  /** Image queries the planner attaches to every page. */
  planQueries?: string[]
  /** Make one host op fail, to check a partial page still counts as a page. */
  failImageInsert?: boolean
  /** Names the AI never read; the generate_deck gate should refuse the run. */
  unread?: string[]
}

function makeHarness(opts: HarnessOptions = {}) {
  let deck: RenderSlide[] = Array.from({ length: opts.initialPages ?? 1 }, (_, i) =>
    slideOf([node(`existing-${i}`)]),
  )
  const ops: string[] = []
  const progress: DeckProgressEvent[] = []
  const qcQueued: number[][] = []
  const sidecars: Array<{ topic: string; styleSkill: string }> = []
  const written: WriteArgs[] = []
  const searched: string[] = []
  let seq = 0

  const replaceNodes = (index: number, nodes: RenderNode[]): RenderSlide => {
    deck = deck.map((s, k) => (k === index ? { ...s, nodes } : s))
    return deck[index]!
  }
  const addNode = (index: number, added: RenderNode): RenderSlide =>
    replaceNodes(index, [...(deck[index]?.nodes ?? []), added])

  installTestPlatform({
    editBackground: async (op: EditBackgroundOp) => {
      ops.push(`bg ${op.slideIndex} ${op.color}`)
      deck = deck.map((s, k) =>
        k === op.slideIndex ? { ...s, background: { kind: 'solid', color: op.color } } : s,
      )
      return deck
    },
    addElement: async (op: AddElementOp) => {
      const label = op.paragraphs?.[0]?.runs[0]?.text ?? ''
      ops.push(`add ${op.slideIndex} ${op.kind}${label ? ` "${label}"` : ''}`)
      seq += 1
      const id = `el-${seq}`
      return {
        slide: addNode(op.slideIndex, node(id, box(op.xPx, op.yPx, op.wPx, op.hPx))),
        sourceId: id,
      }
    },
    insertImageUrl: async (op: {
      slideIndex: number
      url: string
      xPx: number
      yPx: number
      wPx: number
      hPx: number
    }) => {
      if (opts.failImageInsert) {
        ops.push(`image-failed ${op.slideIndex}`)
        return null
      }
      ops.push(`image ${op.slideIndex} ${op.url}`)
      seq += 1
      const id = `img-${seq}`
      return {
        slide: addNode(op.slideIndex, node(id, box(op.xPx, op.yPx, op.wPx, op.hPx))),
        sourceId: id,
      }
    },
    addBlankSlide: async () => {
      ops.push('blank')
      deck = [...deck, slideOf([])]
      return { slides: deck, index: deck.length - 1 }
    },
    deleteSlide: async (index: number) => {
      ops.push(`delete-slide ${index}`)
      deck = deck.filter((_, k) => k !== index)
      return deck
    },
    deleteElement: async (op: DeleteElementOp) => {
      ops.push(`delete-element ${op.slideIndex} ${op.sourceId}`)
      return replaceNodes(
        op.slideIndex,
        (deck[op.slideIndex]?.nodes ?? []).filter((n) => n.sourceId !== op.sourceId),
      )
    },
  })

  const access: DeckAccess = {
    getSlides: () => deck,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: (index, updated) => {
      deck = deck.map((s, k) => (k === index ? updated : s))
    },
    applyDeck: (slides) => {
      deck = slides
    },
    fitWidthPx: 960,
    retryBackoffMs: 0,
    onProgress: (event) => progress.push(event),
    onPagesGenerated: (indexes) => qcQueued.push(indexes),
    saveSidecar: async (data) => {
      sidecars.push({ topic: data.topic, styleSkill: data.styleSkill })
    },
    unreadTextAttachments: () => opts.unread ?? [],
    searchImages: async (query, maxResults) => {
      searched.push(query)
      return (opts.imageUrls ?? ['https://img.test/photo.jpg']).slice(0, maxResults)
    },
    generateStyleSkill: async () => ({ ok: true, styleSkill: STYLE_SKILL }),
    planDeckOutline: async (a) => ({
      ok: true,
      outline: {
        core_hook: 'one line that holds the deck together',
        pages: Array.from({ length: a.count }, (_, i) => ({
          title: `Page ${a.startPage + i}`,
          brief: `brief ${a.startPage + i}`,
          type: i === 0 ? 'cover' : 'content',
          layout: opts.planLayout ?? 'title_bullets',
          image_queries: opts.planQueries ?? [],
        })),
      },
    }),
    writePageSpec: async (a) => {
      written.push(a)
      if (opts.writePageSpec) return opts.writePageSpec(a)
      return { ok: true, spec: contentSpec(a.title || 'Untitled') }
    },
  }

  return {
    access,
    ops,
    progress,
    qcQueued,
    sidecars,
    written,
    searched,
    getDeck: () => deck,
    pagesOf: (predicate: (op: string) => boolean) => ops.filter(predicate),
  }
}

const deckCall = (input: Record<string, unknown>): AgentToolCall => ({
  id: 'call-1',
  name: 'generate_deck',
  input,
})

describe('generate_deck', () => {
  it('plans, writes and lands one page per planned page', async () => {
    const h = makeHarness()
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(deckCall({ topic: 'quarterly review', approx_pages: 4 }))

    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(r.mutated).toBe(true)
    expect(h.getDeck()).toHaveLength(4)
    // One model call per page, in page order, each carrying the deck's shared style.
    expect(h.written.map((w) => w.title)).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4'])
    expect(h.written.every((w) => w.styleSkill === STYLE_SKILL)).toBe(true)
    // The narrative anchor from planning reaches every page's brief.
    expect(h.written[2]?.brief).toContain('one line that holds the deck together')
    // Every page ended up with real elements on it.
    expect(h.getDeck().every((s) => s.nodes.length >= 2)).toBe(true)
    expect(r.output).toContain('Generated 4 of 4 pages')
  })

  it('replace reuses page 1 and drops what was there, rather than generating behind it', async () => {
    const h = makeHarness({ initialPages: 3 })
    const skill = createSlidesSkill(h.access)

    await skill.executeTool(deckCall({ topic: 'reset', approx_pages: 2 }))

    // Pages 2-3 of the old deck are gone, and page 1's own element was cleared.
    expect(h.ops.filter((o) => o.startsWith('delete-slide'))).toEqual([
      'delete-slide 2',
      'delete-slide 1',
    ])
    expect(h.ops).toContain('delete-element 0 existing-0')
    expect(h.getDeck()).toHaveLength(2)
    expect(h.getDeck()[0]?.nodes.some((n) => n.sourceId === 'existing-0')).toBe(false)
  })

  it('append leaves the existing pages untouched', async () => {
    const h = makeHarness({ initialPages: 2 })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(
      deckCall({ topic: 'appendix', approx_pages: 2, insert_mode: 'append' }),
    )

    expect(h.ops.some((o) => o.startsWith('delete-slide'))).toBe(false)
    expect(h.ops.some((o) => o.startsWith('delete-element'))).toBe(false)
    expect(h.getDeck()).toHaveLength(4)
    expect(h.getDeck()[0]?.nodes.map((n) => n.sourceId)).toEqual(['existing-0'])
    expect(h.getDeck()[1]?.nodes.map((n) => n.sourceId)).toEqual(['existing-1'])
    // New pages only, and after the old ones.
    expect(h.getDeck()[2]?.nodes.length).toBeGreaterThan(0)
    expect(r.output).toContain('appended after page 2')
  })

  it('reports progress per stage, with a checklist that flips page by page', async () => {
    const h = makeHarness()
    const skill = createSlidesSkill(h.access)

    await skill.executeTool(deckCall({ topic: 'progress', approx_pages: 3 }))

    expect(h.progress.map((e) => e.stage)).toContain('style')
    expect(h.progress.map((e) => e.stage)).toContain('plan')
    const pageEvents = h.progress.filter((e) => e.stage === 'pages')
    expect(pageEvents.length).toBeGreaterThan(3)
    // The first checklist is all pending, the last is all done, and the counter agrees.
    expect(pageEvents[0]?.pages?.map((p) => p.status)).toEqual(['pending', 'pending', 'pending'])
    const last = pageEvents[pageEvents.length - 1]!
    expect(last.pages?.map((p) => p.status)).toEqual(['done', 'done', 'done'])
    expect(last.done).toBe(3)
    expect(last.status).toBe('done')
    expect(h.progress[h.progress.length - 1]?.stage).toBe('done')
    // The checklist snapshots are copies: a later page landing must not rewrite an earlier event.
    expect(pageEvents[0]?.pages?.[0]?.status).toBe('pending')
  })

  it('one page the model fails on does not take the rest of the run with it', async () => {
    const h = makeHarness({
      writePageSpec: (a) =>
        a.title === 'Page 2'
          ? { ok: false, error: 'the provider dropped the stream' }
          : { ok: true, spec: contentSpec(a.title) },
    })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(deckCall({ topic: 'partial', approx_pages: 3 }))

    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(r.output).toContain('Generated 2 of 3 pages')
    expect(r.output).toContain('still empty: 2')
    const pageEvents = h.progress.filter((e) => e.stage === 'pages')
    const last = pageEvents[pageEvents.length - 1]!
    expect(last.status).toBe('error')
    expect(last.pages?.map((p) => p.status)).toEqual(['done', 'error', 'done'])
    expect(last.pages?.[1]?.error).toContain('dropped the stream')
    // The failed page still exists — empty and ready to be retried, not missing.
    expect(h.getDeck()).toHaveLength(3)
    // The checklist the AI is shown next turn names the page that is still missing.
    expect(skill.buildContext?.()).toContain('page 2 "Page 2"')
    expect(skill.buildContext?.()).toContain('1 still missing')
  })

  it('retries a failed page once before giving up on it', async () => {
    let attempts = 0
    const h = makeHarness({
      writePageSpec: (a) => {
        if (a.title !== 'Page 1') return { ok: true, spec: contentSpec(a.title) }
        attempts += 1
        return attempts === 1
          ? { ok: false, error: 'rate limited' }
          : { ok: true, spec: contentSpec(a.title) }
      },
    })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(deckCall({ topic: 'transient', approx_pages: 2 }))

    expect(attempts).toBe(2)
    expect(r.output).toContain('Generated 2 of 2 pages')
  })

  it('every page fails → the tool errors instead of claiming a deck', async () => {
    const h = makeHarness({ writePageSpec: () => ({ ok: false, error: 'no provider configured' }) })
    const skill = createSlidesSkill(h.access)

    const r = (await skill.executeTool(deckCall({ topic: 'dead', approx_pages: 2 }))) as {
      isError?: boolean
      output: string
    }

    expect(r.isError).toBe(true)
    expect(r.output).toContain('no page could be generated')
  })

  it('a picture layout gets the image the search found', async () => {
    const h = makeHarness({
      planLayout: 'text_left_image_right',
      planQueries: ['city skyline at dusk'],
      imageUrls: ['https://img.test/skyline.jpg'],
      writePageSpec: (a) => ({
        ok: true,
        spec: {
          layout: 'text_left_image_right',
          blocks: [
            { kind: 'title', text: a.title },
            { kind: 'paragraph', text: 'a paragraph of body copy for the page' },
            { kind: 'image', query: 'city skyline at dusk' },
          ],
        },
      }),
    })
    const skill = createSlidesSkill(h.access)

    await skill.executeTool(deckCall({ topic: 'photo deck', approx_pages: 1 }))

    expect(h.searched).toEqual(['city skyline at dusk'])
    expect(h.written[0]?.imageUrls).toEqual(['https://img.test/skyline.jpg'])
    expect(h.ops).toContain('image 0 https://img.test/skyline.jpg')
  })

  it('a dead image degrades to a page without the picture', async () => {
    const h = makeHarness({
      planLayout: 'text_left_image_right',
      planQueries: ['nothing findable'],
      imageUrls: ['https://img.test/gone.jpg'],
      failImageInsert: true,
      writePageSpec: (a) => ({
        ok: true,
        spec: {
          layout: 'text_left_image_right',
          blocks: [
            { kind: 'title', text: a.title },
            { kind: 'paragraph', text: 'body copy that survives the missing photo' },
            { kind: 'image', query: 'nothing findable' },
          ],
        },
      }),
    })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(deckCall({ topic: 'degrade', approx_pages: 1 }))

    expect(r.mutated).toBe(true)
    expect(h.ops).toContain('image-failed 0')
    expect(r.output).toContain('Generated 1 of 1 pages')
    expect(r.output).toContain('page 1: image')
    // The text still landed.
    expect(h.getDeck()[0]?.nodes.length).toBeGreaterThan(0)
  })

  it('an image search that finds nothing is not an error', async () => {
    const h = makeHarness({ planQueries: ['unfindable'], imageUrls: [] })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(deckCall({ topic: 'no photos', approx_pages: 2 }))

    expect(h.written.every((w) => w.imageUrls.length === 0)).toBe(true)
    expect(r.output).toContain('Generated 2 of 2 pages')
  })

  it('explicit pages skip planning entirely', async () => {
    const h = makeHarness()
    let planned = false
    const access: DeckAccess = {
      ...h.access,
      planDeckOutline: async (a) => {
        planned = true
        return h.access.planDeckOutline!(a)
      },
    }
    const skill = createSlidesSkill(access)

    const r = await skill.executeTool(
      deckCall({
        topic: 'hand-written',
        pages: [
          {
            title: 'Cover',
            brief: 'set up the problem',
            type: 'cover',
            layout: 'cover_dark_minimal',
          },
          { title: 'Ask', brief: 'what we need', type: 'closing', layout: 'closing_thank_you' },
        ],
      }),
    )

    expect(planned).toBe(false)
    expect(h.written.map((w) => w.title)).toEqual(['Cover', 'Ask'])
    // The planner's wider layout vocabulary is mapped onto a layout the composer can draw.
    expect(h.written.map((w) => w.layout)).toEqual(['cover_dark_minimal', 'closing_cta'])
    expect(r.output).toContain('Generated 2 of 2 pages')
  })

  it('refuses without a topic or pages, and with unread attachments', async () => {
    const h = makeHarness()
    const empty = (await createSlidesSkill(h.access).executeTool(deckCall({}))) as {
      isError?: boolean
    }
    expect(empty.isError).toBe(true)

    const gated = makeHarness({ unread: ['board-pack.docx'] })
    const r = (await createSlidesSkill(gated.access).executeTool(
      deckCall({ topic: 'from the pack', approx_pages: 3 }),
    )) as { isError?: boolean; output: string }
    expect(r.isError).toBe(true)
    expect(r.output).toContain('board-pack.docx')
    expect(gated.written).toHaveLength(0)
  })

  it('hands the landed page indexes to the host for the layout QC pass', async () => {
    const h = makeHarness({ initialPages: 2 })
    const skill = createSlidesSkill(h.access)

    await skill.executeTool(deckCall({ topic: 'qc', approx_pages: 2, insert_mode: 'append' }))

    // The two appended pages, not the two that were already there.
    expect(h.qcQueued).toEqual([[2, 3]])
  })

  it('keeps the deck style next to the draft, and not when nothing was generated', async () => {
    const h = makeHarness()
    await createSlidesSkill(h.access).executeTool(deckCall({ topic: 'sidecar', approx_pages: 2 }))
    expect(h.sidecars).toEqual([{ topic: 'sidecar', styleSkill: STYLE_SKILL }])

    const dead = makeHarness({ writePageSpec: () => ({ ok: false, error: 'nope' }) })
    await createSlidesSkill(dead.access).executeTool(
      deckCall({ topic: 'sidecar', approx_pages: 2 }),
    )
    expect(dead.sidecars).toEqual([])
  })

  it('a page of placeholder filler counts as a failure, not a page', async () => {
    const h = makeHarness({
      writePageSpec: (a) => ({
        ok: true,
        spec:
          a.title === 'Page 1'
            ? {
                layout: 'title_bullets',
                blocks: [
                  { kind: 'title', text: 'Click to edit Master title style' },
                  { kind: 'bullets', items: ['Text here', 'Text here'] },
                ],
              }
            : contentSpec(a.title),
      }),
    })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(deckCall({ topic: 'filler', approx_pages: 2 }))

    expect(r.output).toContain('Generated 1 of 2 pages')
    expect(r.output).toContain('still empty: 1')
    const last = h.progress.filter((e) => e.stage === 'pages').at(-1)!
    expect(last.pages?.[0]?.error).toContain('template placeholder')
    // Nothing of the filler page was landed.
    expect(h.getDeck()[0]?.nodes).toHaveLength(0)
  })

  it('a deck of specific figures needs a provenance declaration', async () => {
    const h = makeHarness()
    const skill = createSlidesSkill(h.access)

    const ungated = (await skill.executeTool(
      deckCall({
        topic: 'FY26 results',
        approx_pages: 4,
        context: 'revenue grew 31.4% to $2.7 billion',
      }),
    )) as { isError?: boolean; output: string }

    expect(ungated.isError).toBe(true)
    expect(ungated.output).toContain('dataSource is required')
    expect(h.written).toHaveLength(0)

    // 'search' is only honoured once a web_search actually ran in this conversation.
    const unsearched = (await skill.executeTool(
      deckCall({
        topic: 'FY26 results',
        approx_pages: 4,
        context: 'revenue grew 31.4% to $2.7 billion',
        dataSource: 'search',
      }),
    )) as { isError?: boolean; output: string }
    expect(unsearched.isError).toBe(true)
    expect(unsearched.output).toContain('no web_search has run')

    // Declaring the figures illustrative runs, and the AI is told to say so.
    const sampled = await skill.executeTool(
      deckCall({
        topic: 'FY26 results',
        approx_pages: 2,
        context: 'revenue grew 31.4% to $2.7 billion',
        dataSource: 'sample',
      }),
    )
    expect((sampled as { isError?: boolean }).isError).toBeFalsy()
    expect(sampled.output).toContain('illustrative placeholders')
  })

  it('a deck without specific figures needs no declaration', async () => {
    const h = makeHarness()
    const r = await createSlidesSkill(h.access).executeTool(
      deckCall({ topic: 'how our team works in 2026', approx_pages: 2 }),
    )
    expect((r as { isError?: boolean }).isError).toBeFalsy()
    expect(r.output).not.toContain('illustrative')
  })

  it('stop mid-run leaves the pages already made and does not start another', async () => {
    const controller = new AbortController()
    const h = makeHarness({
      writePageSpec: (a) => {
        if (a.title === 'Page 2') controller.abort()
        return { ok: true, spec: contentSpec(a.title) }
      },
    })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(
      deckCall({ topic: 'interrupted', approx_pages: 5 }),
      controller.signal,
    )

    // Page 2 finished the call it was already in; pages 3-5 were never started.
    expect(h.written.map((w) => w.title)).toEqual(['Page 1', 'Page 2'])
    expect(r.output).toContain('Generated 2 of 5 pages')
    // "never started" rather than "failed" — an AI told they failed would retry them.
    expect(r.output).toContain('pages 3-5 were never started')
    expect(r.output).not.toContain('still empty')
    expect(h.getDeck()).toHaveLength(2)
  })

  it('a host without page writing says so instead of half-generating', async () => {
    const h = makeHarness()
    const access: DeckAccess = { ...h.access }
    delete access.writePageSpec
    const r = (await createSlidesSkill(access).executeTool(
      deckCall({ topic: 'no model', approx_pages: 2 }),
    )) as { isError?: boolean; output: string }

    expect(r.isError).toBe(true)
    expect(r.output).toContain('no page could be generated')
  })
})

describe('regenerate_slide', () => {
  const regen = (input: Record<string, unknown>): AgentToolCall => ({
    id: 'call-2',
    name: 'regenerate_slide',
    input,
  })

  it('clears and rewrites only its own page', async () => {
    const h = makeHarness({ initialPages: 3 })
    const skill = createSlidesSkill(h.access)

    const r = await skill.executeTool(
      regen({ slideIndex: 1, title: 'Rewritten', brief: 'say it in three bullets instead' }),
    )

    expect(r.mutated).toBe(true)
    expect(h.ops).toContain('delete-element 1 existing-1')
    expect(h.ops.filter((o) => o.startsWith('delete-element'))).toHaveLength(1)
    expect(h.ops.some((o) => o.startsWith('delete-slide'))).toBe(false)
    expect(h.getDeck()).toHaveLength(3)
    // Its neighbours kept their own elements.
    expect(h.getDeck()[0]?.nodes.map((n) => n.sourceId)).toEqual(['existing-0'])
    expect(h.getDeck()[2]?.nodes.map((n) => n.sourceId)).toEqual(['existing-2'])
    // The page itself was rewritten from the brief.
    expect(h.written[0]?.brief).toBe('say it in three bullets instead')
    expect(h.getDeck()[1]?.nodes.some((n) => n.sourceId === 'existing-1')).toBe(false)
    expect(h.getDeck()[1]?.nodes.length).toBeGreaterThan(0)
    expect(r.output).toContain('Rewrote page 2')
  })

  it('reuses the deck style, so a rewritten page still matches', async () => {
    const h = makeHarness()
    const skill = createSlidesSkill(h.access)
    await skill.executeTool(deckCall({ topic: 'styled', approx_pages: 1 }))
    h.written.length = 0

    await skill.executeTool(regen({ slideIndex: 0, brief: 'tighten this page' }))

    expect(h.written[0]?.styleSkill).toBe(STYLE_SKILL)
  })

  it('only takes http(s) image urls from the AI', async () => {
    const h = makeHarness()
    const skill = createSlidesSkill(h.access)

    await skill.executeTool(
      regen({
        slideIndex: 0,
        brief: 'a page with a photo',
        image_urls: ['javascript:alert(1)', 'file:///etc/passwd', 'https://img.test/ok.png'],
      }),
    )

    expect(h.written[0]?.imageUrls).toEqual(['https://img.test/ok.png'])
  })

  it('queues only its own page for QC, and gates its figures too', async () => {
    const h = makeHarness({ initialPages: 3 })
    const skill = createSlidesSkill(h.access)

    const gated = (await skill.executeTool(
      regen({ slideIndex: 1, brief: 'show the 12.5% margin on $4.1 million of revenue' }),
    )) as { isError?: boolean; output: string }
    expect(gated.isError).toBe(true)
    expect(gated.output).toContain('dataSource is required')
    expect(h.qcQueued).toEqual([])

    await skill.executeTool(regen({ slideIndex: 1, brief: 'tighten the wording' }))
    expect(h.qcQueued).toEqual([[1]])
  })

  it('rejects an out-of-range page and an empty brief', async () => {
    const h = makeHarness()
    const skill = createSlidesSkill(h.access)

    const outOfRange = (await skill.executeTool(regen({ slideIndex: 7, brief: 'x' }))) as {
      isError?: boolean
      output: string
    }
    expect(outOfRange.isError).toBe(true)
    expect(outOfRange.output).toContain('out of range')

    const noBrief = (await skill.executeTool(regen({ slideIndex: 0, brief: '  ' }))) as {
      isError?: boolean
    }
    expect(noBrief.isError).toBe(true)
    expect(h.ops.some((o) => o.startsWith('delete-element'))).toBe(false)
  })
})
