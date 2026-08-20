/** 2.3 Text metrics (fidelity linchpin) — font metrics abstraction layer. */

export interface RunStyle {
  fontFamily: string
  fontSizePx: number
  bold: boolean
  italic: boolean
}

export interface FontMetrics {
  /** Ascent at the font size (baseline to top, px) */
  ascent: number
  /** Descent at the font size (baseline to bottom, px, positive) */
  descent: number
  /** Suggested line height (px) */
  lineHeight: number
}

export interface FontMetricsProvider {
  /** Line metrics for this font + size. */
  metrics(style: RunStyle): FontMetrics
  /** Advance width of a piece of text under this style (px). */
  measure(text: string, style: RunStyle): number
  /** CSS font family actually used for drawing. */
  displayFamily?(style: RunStyle, text?: string): string
}

// ── Grapheme clusters ───────────────────────────────────────────────

const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/**
 * Split by grapheme cluster (combining marks / ZWJ emoji / flags / skin-tone sequences stay
 * intact).
 */
export function graphemes(text: string): string[] {
  if (!SEGMENTER) return [...text]
  const out: string[] = []
  for (const s of SEGMENTER.segment(text)) out.push(s.segment)
  return out
}

// ── Heuristic fallback (deterministic, unit-testable) ───────────────

/** Unicode East Asian Width = Wide/Fullwidth ranges (covers all fullwidth scripts at once; don't patch per language). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo (initial consonants)
  [0x2e80, 0x303e], // CJK radicals / Kangxi radicals / CJK punctuation
  [0x3041, 0x33ff], // Kana / Bopomofo / compatibility Hangul Jamo / CJK compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK basic
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth ASCII
  [0xffe0, 0xffe6], // fullwidth symbols
  [0x1b000, 0x1b2ff], // Kana extensions
  [0x20000, 0x3fffd], // CJK Extension B+
]

/** Whether a code point is EAW fullwidth/wide (word breaking may break per cluster on these). */
export function isWideChar(code: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (code >= lo && code <= hi) return true
  }
  return false
}

/** Estimate advance by character class (ratio relative to font size). */
function charAdvanceEm(code: number): number {
  if (isWideChar(code)) return 1.0
  // emoji ranges (rough)
  if (code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf)) return 1.0
  // narrow characters
  if ("iIlj.,:;'!|".includes(String.fromCharCode(code))) return 0.28
  if (' ftr'.includes(String.fromCharCode(code))) return 0.32
  if ('mwMW'.includes(String.fromCharCode(code))) return 0.82
  // general Latin / digits
  return 0.52
}

/** Zero-width code points: non-spacing combining marks (Thai vowels/tones, diacritics) and format chars (ZWJ etc.). */
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}\p{Cf}]/u
/** Emoji composition parts: ZWJ (200d) / VS16 (fe0f) / regional indicators (flags) / skin-tone modifiers. */
// eslint-disable-next-line no-misleading-character-class -- individual composition code points are matched on purpose
const EMOJI_JOIN_RE = /[\u200d\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u

/**
 * Estimated width of one grapheme cluster: an emoji composition cluster draws as one glyph at 1em;
 * otherwise sum per code point, counting zero-width marks as 0 (spacing vowel marks Mc, e.g.
 */
function clusterAdvanceEm(g: string): number {
  if (g.length > 1 && EMOJI_JOIN_RE.test(g)) return 1.0
  let em = 0
  for (const ch of g) {
    em += ZERO_WIDTH_RE.test(ch) ? 0 : charAdvanceEm(ch.codePointAt(0) ?? 0)
  }
  return em
}

export class HeuristicMetrics implements FontMetricsProvider {
  metrics(style: RunStyle): FontMetrics {
    const s = style.fontSizePx
    // Typical sans-serif ratios: ascent≈0.8em, descent≈0.2em, lineHeight≈1.2em
    return {
      ascent: s * 0.8,
      descent: s * 0.2,
      lineHeight: s * 1.2,
    }
  }

  measure(text: string, style: RunStyle): number {
    let em = 0
    for (const g of graphemes(text)) {
      em += clusterAdvanceEm(g)
    }
    const boldFactor = style.bold ? 1.04 : 1
    return em * style.fontSizePx * boldFactor
  }
}

// ── Exact metrics via opentype.js ───────────────────────────────────

/** Minimal interface of opentype.Font (avoids a hard type dependency; the frontend injects the real instance). */
export interface OpentypeFontLike {
  unitsPerEm: number
  ascender: number
  descender: number
  getAdvanceWidth(text: string, fontSize: number): number
  /** Optional: char → glyph index (0 = missing glyph). Used for the missing-glyph heuristic fallback. */
  charToGlyphIndex?(char: string): number
}

/** Exact metrics using fonts already loaded via opentype.js. */
export class OpentypeMetrics implements FontMetricsProvider {
  constructor(
    private fontResolver: (style: RunStyle) => OpentypeFontLike | undefined,
    private fallback: FontMetricsProvider = new HeuristicMetrics(),
  ) {}

  metrics(style: RunStyle): FontMetrics {
    const font = this.fontResolver(style)
    if (!font) return this.fallback.metrics(style)
    const scale = style.fontSizePx / font.unitsPerEm
    const ascent = font.ascender * scale
    const descent = Math.abs(font.descender) * scale
    return { ascent, descent, lineHeight: ascent + descent }
  }

  measure(text: string, style: RunStyle): number {
    const font = this.fontResolver(style)
    if (!font) return this.fallback.measure(text, style)
    try {
      // Missing-glyph guard: if any character has no glyph (e.g.
      if (font.charToGlyphIndex) {
        for (const ch of text) {
          if (font.charToGlyphIndex(ch) === 0) return this.fallback.measure(text, style)
        }
      }
      return font.getAdvanceWidth(text, style.fontSizePx)
    } catch {
      return this.fallback.measure(text, style)
    }
  }
}

// ── Browser metrics via a canvas 2D context ─────────────────────────

/** What `CanvasMetrics` needs of a 2D canvas context. */
export interface TextMeasureContext {
  /** CSS font shorthand, e.g. `bold 18px "Arial", sans-serif`. Assigned before measuring. */
  font: string
  measureText(text: string): TextMeasureResult
}

/** The part of `TextMetrics` this provider reads. The font-box fields are optional because older engines omit them. */
export interface TextMeasureResult {
  width: number
  fontBoundingBoxAscent?: number
  fontBoundingBoxDescent?: number
}

export interface CanvasMetricsOptions {
  /** A run's font family to the family *stack* the renderer will draw with. */
  familyStack?: (family: string) => string
  /** Used when the context reports no font box, and when a measurement throws. */
  fallback?: FontMetricsProvider
  /** Distinct (font, text) pairs kept before the width cache is dropped. */
  cacheLimit?: number
}

/** Metrics from the browser's own text engine. */
export class CanvasMetrics implements FontMetricsProvider {
  private readonly familyStack: (family: string) => string
  private readonly fallback: FontMetricsProvider
  private readonly cacheLimit: number
  /** Font-box metrics, per font string: independent of the text, so one entry serves every run. */
  private readonly lines = new Map<string, FontMetrics | null>()
  /** Advance widths, per font string plus text. Text layout re-measures the same words constantly. */
  private readonly widths = new Map<string, number>()

  constructor(
    private readonly context: TextMeasureContext,
    options: CanvasMetricsOptions = {},
  ) {
    this.familyStack = options.familyStack ?? ((family) => family)
    this.fallback = options.fallback ?? new HeuristicMetrics()
    this.cacheLimit = options.cacheLimit ?? 20_000
  }

  /** The CSS font shorthand, in the order the renderer's own draw path produces. */
  private fontOf(style: RunStyle): string {
    const parts: string[] = []
    if (style.bold) parts.push('bold')
    if (style.italic) parts.push('italic')
    const stack = this.familyStack(style.fontFamily)
      .split(',')
      .map((family) => {
        const name = family.trim()
        return name.includes(' ') && !/["']/.test(name) ? `"${name}"` : name
      })
      .join(', ')
    return `${parts.join(' ') || 'normal'} normal ${style.fontSizePx}px ${stack}`
  }

  metrics(style: RunStyle): FontMetrics {
    const font = this.fontOf(style)
    const cached = this.lines.get(font)
    if (cached !== undefined) return cached ?? this.fallback.metrics(style)
    let measured: FontMetrics | null = null
    try {
      this.context.font = font
      // 'Mg' rather than the run's own text: the font box is a property of the font, and
      // asking for it once per font is what makes this cache worth having.
      const box = this.context.measureText('Mg')
      if (box.fontBoundingBoxAscent !== undefined && box.fontBoundingBoxDescent !== undefined) {
        const ascent = box.fontBoundingBoxAscent
        const descent = box.fontBoundingBoxDescent
        measured = { ascent, descent, lineHeight: ascent + descent }
      }
    } catch {
      measured = null
    }
    this.lines.set(font, measured)
    return measured ?? this.fallback.metrics(style)
  }

  measure(text: string, style: RunStyle): number {
    if (text === '') return 0
    const font = this.fontOf(style)
    const key = `${font} ${text}`
    const cached = this.widths.get(key)
    if (cached !== undefined) return cached
    let width: number
    try {
      this.context.font = font
      width = this.context.measureText(text).width
    } catch {
      width = this.fallback.measure(text, style)
    }
    // Dropped wholesale rather than evicted one by one: the cache exists to make a layout pass
    // cheap, and a layout pass re-measures whatever it still needs.
    if (this.widths.size >= this.cacheLimit) this.widths.clear()
    this.widths.set(key, width)
    return width
  }
}
