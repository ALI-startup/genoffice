/**
 * The half of deck generation that has no model in it.
 *
 * Placement is arithmetic, so it can be asserted exactly — which is the point of
 * splitting the generator here. What matters most is that a page is *readable*
 * whatever the model returned: contrast is recomputed rather than trusted, junk
 * blocks are dropped rather than drawn, and nothing lands off-canvas.
 */
import { describe, expect, it } from 'vitest'
import {
  composePage,
  DEFAULT_STYLE,
  layoutForPlan,
  luminance,
  PAGE_LAYOUTS,
  parseDeckStyle,
  parsePageSpec,
  type DeckStyle,
  type PageSpec,
} from '../src/renderer/ai/deck-compose'

/** The elements alone; every assertion below is about placement, not background. */
const composePageElements = (...args: Parameters<typeof composePage>) =>
  composePage(...args).elements

const CANVAS = { w: 960, h: 540 }

const spec = (over: Partial<PageSpec> = {}): PageSpec => ({
  layout: 'title_bullets',
  blocks: [
    { kind: 'title', text: 'Quarterly review' },
    { kind: 'bullets', items: ['Revenue up 12%', 'Churn flat'] },
  ],
  ...over,
})

describe('parseDeckStyle', () => {
  it('reads the colours and fonts out of a Style Skill', () => {
    const style = parseDeckStyle(
      [
        'Main background: #10161f',
        'Main text color: #f4f6fa',
        'Primary accent: #4da3ff',
        'Secondary accent: #7de0c2',
        'Card background: #1b2430',
        'Border color: #2a3644',
        'Latin title font: [Inter]',
        'Body font: [Source Sans]',
      ].join('\n'),
    )
    expect(style.background).toBe('#10161f')
    expect(style.accent).toBe('#4da3ff')
    expect(style.card).toBe('#1b2430')
    expect(style.titleFont).toBe('Inter')
    expect(style.bodyFont).toBe('Source Sans')
    expect(style.dark).toBe(true)
  })

  it('falls back to the default palette rather than failing on unusable input', () => {
    expect(parseDeckStyle(undefined)).toEqual(DEFAULT_STYLE)
    expect(parseDeckStyle('a paragraph of prose with no colours in it').background).toBe(
      DEFAULT_STYLE.background,
    )
  })

  it('overrides an unreadable ink the style guide asked for', () => {
    // A model that writes "dark background, dark text" is not rare, and the page
    // it produces is unreadable. Contrast is recomputed, not trusted.
    const style = parseDeckStyle('Main background: #101010\nMain text color: #1a1a1a')
    expect(style.text).toBe('#ffffff')
    expect(luminance(style.background)).toBeLessThan(0.1)

    const light = parseDeckStyle('Main background: #ffffff\nMain text color: #fafafa')
    expect(light.text).toBe('#1b1b1f')
  })
})

describe('parsePageSpec', () => {
  it('keeps well-formed blocks and drops the rest', () => {
    const parsed = parsePageSpec({
      layout: 'title_bullets',
      blocks: [
        { kind: 'title', text: '  Spaced   out  ' },
        { kind: 'bullets', items: ['one', '', 42, 'two'] },
        { kind: 'nonsense', text: 'x' },
        { kind: 'stats', items: [{ value: '12%', label: 'growth' }, { value: 'no label' }] },
      ],
    })
    expect(parsed?.blocks).toEqual([
      { kind: 'title', text: 'Spaced out' },
      { kind: 'bullets', items: ['one', 'two'] },
      { kind: 'stats', items: [{ value: '12%', label: 'growth' }] },
    ])
  })

  it('rejects a spec with nothing drawable in it', () => {
    expect(parsePageSpec({ layout: 'title_bullets', blocks: [] })).toBeNull()
    expect(
      parsePageSpec({ layout: 'title_bullets', blocks: [{ kind: 'title', text: '   ' }] }),
    ).toBeNull()
    expect(parsePageSpec('not an object')).toBeNull()
  })

  it('substitutes a drawable layout for one the composer does not know', () => {
    expect(
      parsePageSpec({ layout: 'invented_layout', blocks: [{ kind: 'title', text: 'T' }] })?.layout,
    ).toBe('title_bullets')
  })

  it('only accepts an http(s) image url', () => {
    const ok = parsePageSpec({
      layout: 'title_bullets',
      blocks: [{ kind: 'image', query: 'harbour', url: 'https://example.com/a.jpg' }],
    })
    expect(ok?.blocks[0]).toEqual({
      kind: 'image',
      query: 'harbour',
      url: 'https://example.com/a.jpg',
    })
    const bad = parsePageSpec({
      layout: 'title_bullets',
      blocks: [{ kind: 'image', query: 'harbour', url: 'javascript:alert(1)' }],
    })
    expect(bad?.blocks[0]).toEqual({ kind: 'image', query: 'harbour' })
  })
})

describe('layoutForPlan', () => {
  it('maps the planner’s wider vocabulary onto layouts the composer draws', () => {
    expect(layoutForPlan('cover_full_image_overlay')).toBe('cover_split_image')
    expect(layoutForPlan('cover_magazine')).toBe('cover_split_image')
    expect(layoutForPlan('timeline_horizontal')).toBe('title_bullets')
    expect(layoutForPlan('hero_big_number')).toBe('hero_stat')
    expect(layoutForPlan('two_by_two_grid')).toBe('three_column_cards')
    expect(layoutForPlan('closing_thank_you')).toBe('closing_cta')
    // A name it already knows passes through untouched.
    expect(layoutForPlan('kpi_cards_row')).toBe('kpi_cards_row')
    // Nothing recognisable: fall back by page type, then to a layout that always reads.
    expect(layoutForPlan('', 'data')).toBe('kpi_cards_row')
    expect(layoutForPlan('', 'cover')).toBe('cover_typography_hero')
    expect(layoutForPlan(undefined)).toBe('title_bullets')
  })
})

describe('composePage', () => {
  it('reports the background separately, so it becomes the slide’s own', () => {
    // Not emitted as a full-bleed shape: that would be one more element for the
    // user to select and drag off the page.
    const page = composePage(spec(), parseDeckStyle('Main background: #10161f'), CANVAS)
    expect(page.background).toBe('#10161f')
    expect(page.elements.every((e) => !(e.w === CANVAS.w && e.h === CANVAS.h))).toBe(true)
  })

  it('returns elements back to front', () => {
    const page = composePage(
      {
        layout: 'three_column_cards',
        blocks: [
          { kind: 'title', text: 'T' },
          { kind: 'columns', items: [{ heading: 'A', body: 'a' }] },
        ],
      },
      DEFAULT_STYLE,
      CANVAS,
    )
    const zs = page.elements.map((e) => e.z)
    expect(zs).toEqual([...zs].sort((a, b) => a - b))
  })

  it('keeps every element inside the canvas, for every layout', () => {
    const style = parseDeckStyle('Main background: #ffffff')
    const rich: PageSpec['blocks'] = [
      { kind: 'title', text: 'Title' },
      { kind: 'subtitle', text: 'Subtitle' },
      { kind: 'bullets', items: ['a', 'b', 'c'] },
      { kind: 'paragraph', text: 'Some prose.' },
      {
        kind: 'stats',
        items: [
          { value: '1', label: 'one' },
          { value: '2', label: 'two' },
          { value: '3', label: 'three' },
          { value: '4', label: 'four' },
        ],
      },
      {
        kind: 'columns',
        items: [
          { heading: 'A', body: 'a' },
          { heading: 'B', body: 'b' },
          { heading: 'C', body: 'c' },
        ],
      },
      { kind: 'image', query: 'x', url: 'https://example.com/a.jpg' },
      { kind: 'note', text: 'Source: internal' },
    ]
    for (const layout of PAGE_LAYOUTS) {
      const els = composePageElements({ layout, blocks: rich }, style, CANVAS)
      expect(els.length, layout).toBeGreaterThan(1)
      for (const e of els) {
        expect(e.x, `${layout} x`).toBeGreaterThanOrEqual(0)
        expect(e.y, `${layout} y`).toBeGreaterThanOrEqual(0)
        expect(e.x + e.w, `${layout} right`).toBeLessThanOrEqual(CANVAS.w)
        expect(e.y + e.h, `${layout} bottom`).toBeLessThanOrEqual(CANVAS.h + 1)
        expect(e.w, `${layout} w`).toBeGreaterThan(0)
        expect(e.h, `${layout} h`).toBeGreaterThan(0)
      }
    }
  })

  it('draws cards behind their text, so the text is not hidden', () => {
    const els = composePageElements(
      {
        layout: 'three_column_cards',
        blocks: [
          { kind: 'title', text: 'Three ways' },
          {
            kind: 'columns',
            items: [
              { heading: 'One', body: 'a' },
              { heading: 'Two', body: 'b' },
            ],
          },
        ],
      },
      DEFAULT_STYLE,
      CANVAS,
    )
    const cards = els.filter((e) => e.kind === 'shape' && e.geometry === 'roundRect')
    const labels = els.filter((e) => e.kind === 'textbox' && e.z === 3)
    expect(cards).toHaveLength(2)
    expect(labels).toHaveLength(2)
    for (const card of cards) expect(card.z).toBeLessThan(labels[0]!.z)
  })

  it('scales the type to the canvas rather than the pixel count', () => {
    const small = composePageElements(spec(), DEFAULT_STYLE, { w: 720, h: 405 })
    const large = composePageElements(spec(), DEFAULT_STYLE, { w: 1920, h: 1080 })
    const size = (els: ReturnType<typeof composePageElements>) =>
      els.find((e) => e.paragraphs?.[0]?.bold)?.paragraphs?.[0]?.size ?? 0
    expect(size(large)).toBeGreaterThan(size(small))
  })

  it('falls back to a paragraph when a bullets layout got prose instead', () => {
    const els = composePageElements(
      {
        layout: 'title_bullets',
        blocks: [
          { kind: 'title', text: 'T' },
          { kind: 'paragraph', text: 'One long thought.' },
        ],
      },
      DEFAULT_STYLE,
      CANVAS,
    )
    const bodies = els.filter((e) => e.paragraphs?.some((p) => p.text === 'One long thought.'))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.paragraphs![0]!.bullet).toBeFalsy()
  })

  it('places an image on the side the layout names', () => {
    const blocks: PageSpec['blocks'] = [
      { kind: 'title', text: 'T' },
      { kind: 'image', query: 'q', url: 'https://example.com/a.jpg' },
    ]
    const right = composePageElements(
      { layout: 'text_left_image_right', blocks },
      DEFAULT_STYLE,
      CANVAS,
    )
    const left = composePageElements(
      { layout: 'image_left_text_right', blocks },
      DEFAULT_STYLE,
      CANVAS,
    )
    const imageX = (els: ReturnType<typeof composePageElements>) =>
      els.find((e) => e.kind === 'image')!.x
    expect(imageX(right)).toBeGreaterThan(CANVAS.w / 2)
    expect(imageX(left)).toBeLessThan(CANVAS.w / 2)
  })

  it('uses the style ink for body text on a dark deck', () => {
    const style: DeckStyle = parseDeckStyle('Main background: #101820\nPrimary accent: #55ccff')
    const els = composePageElements(spec(), style, CANVAS)
    const body = els.find((e) => e.paragraphs?.some((p) => p.text === 'Revenue up 12%'))
    expect(body!.paragraphs![0]!.color).toBe('#ffffff')
  })
})
