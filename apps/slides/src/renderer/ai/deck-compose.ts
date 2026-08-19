/**
 * Deck generation, composed from native elements.
 *
 * The previous generator handed each page's brief to a cloud service that wrote
 * HTML and returned a one-slide pptx; `slides:html-to-pptx` only ever unpacked
 * those. That service is gone, and there has never been a local HTML→pptx
 * converter to fall back to — so generation is rebuilt the other way round: the
 * model writes a *page spec* (what goes on the page), and this module decides
 * *where it goes*.
 *
 * Splitting it there is what makes it work on any provider. The model is asked
 * only for content and a layout name, which any instruct-tuned model can produce
 * — no CSS, no absolute coordinates, no pptx. Placement is arithmetic here:
 * deterministic, unit-testable, and identical whichever model answered. It also
 * means every generated page is made of real editable elements from the start,
 * rather than a converted picture of a page.
 *
 * Everything is expressed in the deck's own pixel canvas (`RenderSlide.widthPx`
 * / `heightPx`), which is what the element ops take.
 */

/** One block of content the model asked for. `kind` decides how it is drawn. */
export type SpecBlock =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'paragraph'; text: string }
  /** A big number with a caption — the "hero stat" and KPI-card content. */
  | { kind: 'stats'; items: { value: string; label: string }[] }
  /** Two or three titled columns of prose. */
  | { kind: 'columns'; items: { heading: string; body: string }[] }
  /** Where a picture goes; the URL is filled in by the caller from image search. */
  | { kind: 'image'; query: string; url?: string }
  | { kind: 'note'; text: string }

/** The layouts the composer can draw. The model must pick one of these names. */
export const PAGE_LAYOUTS = [
  'cover_typography_hero',
  'cover_split_image',
  'cover_dark_minimal',
  'title_bullets',
  'text_left_image_right',
  'image_left_text_right',
  'three_column_cards',
  'hero_stat',
  'kpi_cards_row',
  'two_column_comparison',
  'closing_cta',
] as const

export type PageLayout = (typeof PAGE_LAYOUTS)[number]

export interface PageSpec {
  layout: PageLayout
  blocks: SpecBlock[]
}

/** The deck's visual language, read out of the Style Skill text. */
export interface DeckStyle {
  background: string
  text: string
  accent: string
  accentSoft: string
  card: string
  border: string
  titleFont: string
  bodyFont: string
  /** True when the background is dark enough that text must be light. */
  dark: boolean
}

export const DEFAULT_STYLE: DeckStyle = {
  background: '#ffffff',
  text: '#1b1b1f',
  accent: '#2f6fd0',
  accentSoft: '#eaf1fb',
  card: '#f5f7fa',
  border: '#dfe3e8',
  titleFont: 'Arial',
  bodyFont: 'Arial',
  dark: false,
}

const HEX = /#[0-9a-fA-F]{6}\b/

/** Relative luminance, for deciding whether a background needs light text. */
export function luminance(hex: string): number {
  const v = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Pick the readable ink for a background, ignoring what the model claimed. */
function inkFor(background: string, preferred: string): string {
  const bg = luminance(background)
  const fg = luminance(preferred)
  // WCAG contrast ratio; 3:1 is the floor for the large type this generator uses.
  const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)
  if (ratio >= 3) return preferred
  return bg < 0.5 ? '#ffffff' : '#1b1b1f'
}

/**
 * Read the Style Skill's colours and fonts.
 *
 * The style guide is model-written prose in a known shape ("Main background:
 * #hex"), so this is deliberately forgiving: every field falls back to the
 * default rather than failing the page, and the ink is recomputed for contrast
 * regardless of what the guide said — an unreadable page is worse than an
 * off-palette one.
 */
export function parseDeckStyle(styleSkill: string | undefined): DeckStyle {
  const s = String(styleSkill ?? '')
  const pick = (...labels: string[]): string | null => {
    for (const label of labels) {
      const re = new RegExp(`${label}[^\\n#]*(${HEX.source})`, 'i')
      const m = re.exec(s)
      if (m) return m[1]!.toLowerCase()
    }
    return null
  }
  const font = (label: string): string | null => {
    const m = new RegExp(`${label}\\s*[::]\\s*\\[?([^\\n\\]]+)`, 'i').exec(s)
    const name = m?.[1]?.trim().replace(/[.,;]$/, '')
    return name && !/^#/.test(name) ? name : null
  }
  const background = pick('main background', 'background') ?? DEFAULT_STYLE.background
  const accent = pick('primary accent', 'accent') ?? DEFAULT_STYLE.accent
  return {
    background,
    text: inkFor(background, pick('main text colou?r', 'text colou?r') ?? DEFAULT_STYLE.text),
    accent,
    accentSoft: pick('secondary accent') ?? DEFAULT_STYLE.accentSoft,
    card:
      pick('card background') ?? (luminance(background) < 0.5 ? '#ffffff14' : DEFAULT_STYLE.card),
    border: pick('border colou?r') ?? DEFAULT_STYLE.border,
    titleFont: font('(?:latin )?title font') ?? DEFAULT_STYLE.titleFont,
    bodyFont: font('body font') ?? DEFAULT_STYLE.bodyFont,
    dark: luminance(background) < 0.5,
  }
}

/** A positioned element for the composer's caller to create. */
export interface ComposedElement {
  kind: 'textbox' | 'shape' | 'image'
  x: number
  y: number
  w: number
  h: number
  /** Shape geometry name (`kind: 'shape'`), e.g. rect / roundRect. */
  geometry?: string
  fill?: string
  /** Paragraphs, already carrying their type size, weight, colour and alignment. */
  paragraphs?: ComposedParagraph[]
  /** Image source (`kind: 'image'`). */
  url?: string
  /** Draw order matters: backgrounds and cards go down before the text on them. */
  z: number
}

export interface ComposedParagraph {
  text: string
  size: number
  bold?: boolean
  color: string
  font: string
  align?: 'left' | 'center' | 'right'
  bullet?: boolean
}

export interface Canvas {
  w: number
  h: number
}

/** Type scale, in points, derived from the canvas height so 4:3 and 16:9 both read. */
function scale(canvas: Canvas) {
  const k = canvas.h / 540
  return {
    hero: Math.round(54 * k),
    title: Math.round(34 * k),
    subtitle: Math.round(20 * k),
    body: Math.round(16 * k),
    caption: Math.round(12 * k),
    stat: Math.round(62 * k),
    pad: Math.round(48 * k),
    gap: Math.round(18 * k),
  }
}

const find = <K extends SpecBlock['kind']>(
  blocks: SpecBlock[],
  kind: K,
): Extract<SpecBlock, { kind: K }> | undefined =>
  blocks.find((b): b is Extract<SpecBlock, { kind: K }> => b.kind === kind)

/** A laid-out page: the slide's own background, plus what goes on top of it. */
export interface ComposedPage {
  /** Applied as the slide background, not as a shape — nothing for the user to move. */
  background: string
  elements: ComposedElement[]
}

/**
 * Place a page's blocks.
 *
 * Pure, and the reason the generator is reproducible: the same spec and style
 * always produce the same geometry, so a page can be regenerated, diffed, or
 * asserted in a test without a model in the loop.
 */
export function composePage(spec: PageSpec, style: DeckStyle, canvas: Canvas): ComposedPage {
  const t = scale(canvas)
  const out: ComposedElement[] = []
  const body = { size: t.body, color: style.text, font: style.bodyFont }
  const push = (e: ComposedElement) => void out.push(e)

  const title = find(spec.blocks, 'title')?.text
  const subtitle = find(spec.blocks, 'subtitle')?.text
  const bullets = find(spec.blocks, 'bullets')?.items ?? []
  const paragraph = find(spec.blocks, 'paragraph')?.text
  const stats = find(spec.blocks, 'stats')?.items ?? []
  const columns = find(spec.blocks, 'columns')?.items ?? []
  const image = find(spec.blocks, 'image')
  const note = find(spec.blocks, 'note')?.text

  const inner = canvas.w - t.pad * 2
  const text = (
    x: number,
    y: number,
    w: number,
    h: number,
    paragraphs: ComposedParagraph[],
    z = 2,
  ) => push({ kind: 'textbox', x, y, w, h, paragraphs, z })

  const para = (s: string, over: Partial<ComposedParagraph> = {}): ComposedParagraph => ({
    ...body,
    text: s,
    ...over,
  })

  switch (spec.layout) {
    case 'cover_typography_hero':
    case 'cover_dark_minimal': {
      const centred = spec.layout === 'cover_dark_minimal'
      const align = centred ? 'center' : 'left'
      const top = centred ? Math.round(canvas.h * 0.32) : Math.round(canvas.h * 0.34)
      if (title)
        text(t.pad, top, inner, t.hero * 2, [para(title, { size: t.hero, bold: true, align })])
      if (subtitle)
        text(t.pad, top + Math.round(t.hero * 1.9), inner, t.subtitle * 2.4, [
          para(subtitle, { size: t.subtitle, color: style.accent, align }),
        ])
      // A rule under the title, in the accent: the one piece of furniture a
      // cover needs to stop looking like a slide with words dropped on it.
      if (!centred)
        push({
          kind: 'shape',
          geometry: 'rect',
          x: t.pad,
          y: top - t.gap,
          w: Math.round(inner * 0.18),
          h: Math.max(3, Math.round(t.gap / 4)),
          fill: style.accent,
          z: 1,
        })
      break
    }
    case 'cover_split_image': {
      const half = Math.round(canvas.w * 0.46)
      if (image)
        push({
          kind: 'image',
          x: canvas.w - half,
          y: 0,
          w: half,
          h: canvas.h,
          ...(image.url ? { url: image.url } : {}),
          z: 1,
        })
      const w = canvas.w - half - t.pad * 2
      if (title)
        text(t.pad, Math.round(canvas.h * 0.3), w, t.hero * 2.2, [
          para(title, { size: Math.round(t.hero * 0.86), bold: true }),
        ])
      if (subtitle)
        text(t.pad, Math.round(canvas.h * 0.3) + Math.round(t.hero * 1.8), w, t.subtitle * 3, [
          para(subtitle, { size: t.subtitle, color: style.accent }),
        ])
      break
    }
    case 'title_bullets': {
      if (title)
        text(t.pad, t.pad, inner, t.title * 1.6, [para(title, { size: t.title, bold: true })])
      const top = t.pad + Math.round(t.title * 1.9)
      const items = bullets.length ? bullets : paragraph ? [paragraph] : []
      if (items.length)
        text(
          t.pad,
          top,
          inner,
          canvas.h - top - t.pad,
          items.map((s) => para(s, { bullet: bullets.length > 0 })),
        )
      break
    }
    case 'text_left_image_right':
    case 'image_left_text_right': {
      const imageRight = spec.layout === 'text_left_image_right'
      const half = Math.round((canvas.w - t.pad * 3) / 2)
      const textX = imageRight ? t.pad : t.pad * 2 + half
      const imageX = imageRight ? t.pad * 2 + half : t.pad
      if (image)
        push({
          kind: 'image',
          x: imageX,
          y: t.pad,
          w: half,
          h: canvas.h - t.pad * 2,
          ...(image.url ? { url: image.url } : {}),
          z: 1,
        })
      if (title)
        text(textX, t.pad, half, t.title * 1.8, [
          para(title, { size: Math.round(t.title * 0.86), bold: true }),
        ])
      const top = t.pad + Math.round(t.title * 2)
      const items = bullets.length ? bullets : paragraph ? [paragraph] : []
      if (items.length)
        text(
          textX,
          top,
          half,
          canvas.h - top - t.pad,
          items.map((s) => para(s, { bullet: bullets.length > 0 })),
        )
      break
    }
    case 'three_column_cards':
    case 'two_column_comparison': {
      const wanted = spec.layout === 'three_column_cards' ? 3 : 2
      const cols = (
        columns.length ? columns : bullets.map((b) => ({ heading: b, body: '' }))
      ).slice(0, wanted)
      if (title)
        text(t.pad, t.pad, inner, t.title * 1.6, [para(title, { size: t.title, bold: true })])
      const top = t.pad + Math.round(t.title * 2)
      const n = Math.max(cols.length, 1)
      const cardW = Math.round((inner - t.gap * (n - 1)) / n)
      const cardH = canvas.h - top - t.pad
      cols.forEach((c, i) => {
        const x = t.pad + i * (cardW + t.gap)
        push({
          kind: 'shape',
          geometry: 'roundRect',
          x,
          y: top,
          w: cardW,
          h: cardH,
          fill: style.card,
          z: 1,
        })
        const paragraphs = [
          para(c.heading, { size: Math.round(t.subtitle * 0.95), bold: true, color: style.accent }),
        ]
        if (c.body) paragraphs.push(para(c.body))
        text(x + t.gap, top + t.gap, cardW - t.gap * 2, cardH - t.gap * 2, paragraphs, 3)
      })
      break
    }
    case 'hero_stat': {
      const stat = stats[0]
      if (title)
        text(t.pad, t.pad, inner, t.title * 1.6, [
          para(title, { size: Math.round(t.title * 0.8), bold: true }),
        ])
      if (stat) {
        const top = Math.round(canvas.h * 0.34)
        text(t.pad, top, inner, t.stat * 1.5, [
          para(stat.value, { size: t.stat, bold: true, color: style.accent }),
        ])
        text(t.pad, top + Math.round(t.stat * 1.25), inner, t.subtitle * 2.4, [
          para(stat.label, { size: t.subtitle }),
        ])
      }
      if (paragraph)
        text(t.pad, canvas.h - t.pad - t.body * 4, inner, t.body * 4, [para(paragraph)])
      break
    }
    case 'kpi_cards_row': {
      if (title)
        text(t.pad, t.pad, inner, t.title * 1.6, [para(title, { size: t.title, bold: true })])
      const top = Math.round(canvas.h * 0.36)
      const cards = stats.slice(0, 4)
      const n = Math.max(cards.length, 1)
      const cardW = Math.round((inner - t.gap * (n - 1)) / n)
      const cardH = Math.round(canvas.h * 0.34)
      cards.forEach((s, i) => {
        const x = t.pad + i * (cardW + t.gap)
        push({
          kind: 'shape',
          geometry: 'roundRect',
          x,
          y: top,
          w: cardW,
          h: cardH,
          fill: style.card,
          z: 1,
        })
        text(
          x + t.gap,
          top + t.gap,
          cardW - t.gap * 2,
          Math.round(cardH * 0.5),
          [
            para(s.value, {
              size: Math.round(t.stat * 0.62),
              bold: true,
              color: style.accent,
              align: 'center',
            }),
          ],
          3,
        )
        text(
          x + t.gap,
          top + Math.round(cardH * 0.62),
          cardW - t.gap * 2,
          Math.round(cardH * 0.34),
          [para(s.label, { size: t.caption, align: 'center' })],
          3,
        )
      })
      break
    }
    case 'closing_cta': {
      const top = Math.round(canvas.h * 0.36)
      if (title)
        text(t.pad, top, inner, t.hero * 1.6, [
          para(title, { size: Math.round(t.hero * 0.8), bold: true, align: 'center' }),
        ])
      if (subtitle)
        text(t.pad, top + Math.round(t.hero * 1.4), inner, t.subtitle * 2.4, [
          para(subtitle, { size: t.subtitle, color: style.accent, align: 'center' }),
        ])
      break
    }
  }

  if (note)
    text(
      t.pad,
      canvas.h - Math.round(t.pad * 0.6),
      inner,
      t.caption * 2,
      [para(note, { size: t.caption })],
      4,
    )
  // Painted back to front, so a card never lands on top of its own label.
  out.sort((a, b) => a.z - b.z)
  return { background: style.background, elements: out }
}

// ── validation ───────────────────────────────────────────────────────────────
// The model's JSON is untrusted input: it arrives from whatever provider the
// user configured, at whatever instruction-following quality that model has. So
// every field is checked, unknown block kinds are dropped rather than failing
// the page, and a spec that survives is one `composePage` can lay out without
// a single defensive check of its own.

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A non-empty single-line string, truncated: a model sometimes writes an essay into a title. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

function strings(v: unknown, max: number, cap: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => str(x, max))
    .filter((x): x is string => x !== null)
    .slice(0, cap)
}

function parseBlock(raw: unknown): SpecBlock | null {
  if (!isRecord(raw)) return null
  switch (raw.kind) {
    case 'title':
    case 'subtitle':
    case 'paragraph':
    case 'note': {
      const text = str(raw.text, raw.kind === 'paragraph' ? 600 : 160)
      return text ? ({ kind: raw.kind, text } as SpecBlock) : null
    }
    case 'bullets': {
      const items = strings(raw.items, 220, 8)
      return items.length ? { kind: 'bullets', items } : null
    }
    case 'stats': {
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .map((x) => {
          if (!isRecord(x)) return null
          const value = str(x.value, 24)
          const label = str(x.label, 90)
          return value && label ? { value, label } : null
        })
        .filter((x): x is { value: string; label: string } => x !== null)
        .slice(0, 4)
      return items.length ? { kind: 'stats', items } : null
    }
    case 'columns': {
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .map((x) => {
          if (!isRecord(x)) return null
          const heading = str(x.heading, 80)
          return heading ? { heading, body: str(x.body, 320) ?? '' } : null
        })
        .filter((x): x is { heading: string; body: string } => x !== null)
        .slice(0, 3)
      return items.length ? { kind: 'columns', items } : null
    }
    case 'image': {
      const query = str(raw.query, 120)
      const url = typeof raw.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url : undefined
      return query || url ? { kind: 'image', query: query ?? '', ...(url ? { url } : {}) } : null
    }
    default:
      return null
  }
}

const isLayout = (v: unknown): v is PageLayout =>
  typeof v === 'string' && (PAGE_LAYOUTS as readonly string[]).includes(v)

/**
 * Validate one page spec.
 *
 * `fallbackLayout` is what an unrecognised layout name becomes — the planner
 * suggests layouts from a wider vocabulary than the composer draws, and a page
 * laid out plainly beats a page refused.
 */
export function parsePageSpec(
  raw: unknown,
  fallbackLayout: PageLayout = 'title_bullets',
): PageSpec | null {
  if (!isRecord(raw)) return null
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : [])
    .map(parseBlock)
    .filter((b): b is SpecBlock => b !== null)
  if (!blocks.length) return null
  return { layout: isLayout(raw.layout) ? raw.layout : fallbackLayout, blocks }
}

/**
 * Map a planner layout name onto one the composer draws.
 *
 * The outline planner's vocabulary predates this module (its prompt lists
 * `timeline_horizontal`, `full_image_text_overlay` and others), so rather than
 * narrow the planner — which would make its outlines worse — near-misses are
 * mapped by intent and anything unknown lands on a layout that always reads.
 */
export function layoutForPlan(name: unknown, pageType?: unknown): PageLayout {
  const n = String(name ?? '').toLowerCase()
  if (isLayout(n)) return n
  const type = String(pageType ?? '').toLowerCase()
  if (n.includes('cover') || type === 'cover') {
    if (n.includes('image') || n.includes('photo') || n.includes('magazine'))
      return 'cover_split_image'
    if (n.includes('dark') || n.includes('minimal')) return 'cover_dark_minimal'
    return 'cover_typography_hero'
  }
  if (n.includes('closing') || type === 'closing') return 'closing_cta'
  if (n.includes('kpi')) return 'kpi_cards_row'
  if (n.includes('big_number') || n.includes('hero')) return 'hero_stat'
  if (n.includes('comparison')) return 'two_column_comparison'
  if (n.includes('three') || n.includes('card') || n.includes('grid')) return 'three_column_cards'
  if (n.includes('image_left') || n.includes('right_text')) return 'image_left_text_right'
  if (n.includes('image') || n.includes('photo')) return 'text_left_image_right'
  if (type === 'data') return 'kpi_cards_row'
  return 'title_bullets'
}
