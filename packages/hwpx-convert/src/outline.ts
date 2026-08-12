/**
 * Paragraph roles recovered straight from the HWPX package.
 *
 * `neoali-hwpxjs` renders a document to display HTML: every body paragraph comes
 * back as a `<p>`, whatever role it had. Headings arrive flattened to body text,
 * and list items arrive as ordinary paragraphs whose bullet or number has been
 * baked into the text as literal characters (`"• item"`, `"1. item"`).
 *
 * For a viewer that is the right call. For an importer it is not: flattening
 * headings loses the document's structure, and a literal bullet is corrupting —
 * re-exporting such a paragraph prefixes it a second time, so a round trip turns
 * `1. one` into `1. 1. one`.
 *
 * Both roles are still in the package, in the two files the renderer's public API
 * does not expose. This module reads them directly, using the same jszip +
 * fast-xml-parser pair the rest of the repo already depends on:
 *
 *   - `Contents/header.xml` holds the style table (`hh:style`, keyed by the
 *     `styleIDRef` a paragraph carries) and the paragraph-property table
 *     (`hh:paraPr`, keyed by `paraPrIDRef`), which is where `hh:heading` records
 *     whether a paragraph is an outline heading, a numbered item or a bullet.
 *   - `Contents/section*.xml` holds the body, whose *direct* `hp:p` children are
 *     the top-level blocks in document order.
 *
 * The result is positional: entry `i` describes the i-th top-level block. Callers
 * must treat a length mismatch against the rendered HTML as "no information" and
 * fall back, never as an off-by-one to absorb — see `normalize.ts`.
 */
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/** What a top-level HWPX paragraph is, once its style and paragraph properties are resolved. */
export type ParagraphRole =
  | { kind: 'heading'; level: number }
  | { kind: 'list'; ordered: boolean; level: number }
  | { kind: 'body' }

export interface ParagraphInfo {
  role: ParagraphRole
  /** Horizontal alignment, or null when the paragraph is left-aligned or unset. */
  align: 'center' | 'right' | 'justify' | null
}

/** Attribute-prefixed parse: `@_` keeps attributes clearly separate from child elements. */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // A single-element list must still parse as an array, or a one-paragraph
  // document would yield an object and silently produce zero blocks.
  isArray: (name) => name === 'hp:p' || name === 'hh:style' || name === 'hh:paraPr',
})

type XmlNode = Record<string, unknown>

const asArray = (value: unknown): XmlNode[] =>
  Array.isArray(value) ? (value as XmlNode[]) : value ? [value as XmlNode] : []

const attr = (node: XmlNode | undefined, name: string): string | undefined => {
  const value = node?.[`@_${name}`]
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * Heading level from a style name.
 *
 * Both the English and the Korean built-in names are matched, because a
 * document authored in Hangul Word Processor carries the Korean ones and only
 * files that passed through an English build carry `engName`. `제목 N` is
 * "Heading N" and `개요 N` is "Outline N"; the bare `제목` / `Title` is the
 * document title, which maps to level 1, and `부제목` / `Subtitle` to level 2.
 */
function headingLevelFromStyleName(name: string | undefined): number | null {
  if (!name) return null
  const trimmed = name.trim()
  if (/^(title|제목)$/i.test(trimmed)) return 1
  if (/^(subtitle|부제목)$/i.test(trimmed)) return 2
  const match = /^(?:heading|outline|제목|개요)\s*([1-9])$/i.exec(trimmed)
  return match ? Number(match[1]) : null
}

/** Clamp to the six levels the editor's restricted HTML can express. */
const clampLevel = (level: number): number => Math.min(Math.max(level, 1), 6)

/** Case-insensitive lookup, since the archive's own casing is not guaranteed. */
function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const wanted = path.toLowerCase()
  for (const name of Object.keys(zip.files)) {
    if (name.toLowerCase() === wanted) return zip.files[name]
  }
  return null
}

/**
 * Section parts in body order.
 *
 * Sorted numerically rather than lexically: `section10.xml` must follow
 * `section9.xml`, which a plain string sort gets backwards.
 */
function sectionEntries(zip: JSZip): JSZip.JSZipObject[] {
  const sections: Array<{ index: number; entry: JSZip.JSZipObject }> = []
  for (const name of Object.keys(zip.files)) {
    const match = /^contents\/section(\d+)\.xml$/i.exec(name)
    if (match) sections.push({ index: Number(match[1]), entry: zip.files[name] })
  }
  return sections.sort((a, b) => a.index - b.index).map((s) => s.entry)
}

interface HeaderTables {
  /** styleIDRef -> heading level, for styles that name a heading. */
  styleHeadingLevel: Map<string, number>
  /** styleIDRef -> the paraPr the style itself points at (a paragraph may inherit its role). */
  styleParaPr: Map<string, string>
  paraPr: Map<string, { role: ParagraphRole; align: ParagraphInfo['align'] }>
}

function alignOf(paraPr: XmlNode): ParagraphInfo['align'] {
  const horizontal = attr(paraPr['hh:align'] as XmlNode | undefined, 'horizontal')?.toUpperCase()
  if (horizontal === 'CENTER') return 'center'
  if (horizontal === 'RIGHT') return 'right'
  // HWPX distinguishes JUSTIFY from DISTRIBUTE; both render as justified text.
  if (horizontal === 'JUSTIFY' || horizontal === 'DISTRIBUTE') return 'justify'
  return null
}

function roleOf(paraPr: XmlNode): ParagraphRole {
  const heading = paraPr['hh:heading'] as XmlNode | undefined
  const type = attr(heading, 'type')?.toUpperCase()
  // HWPX levels are zero-based; HTML heading levels start at one.
  const level = Number(attr(heading, 'level') ?? '0') || 0
  if (type === 'OUTLINE') return { kind: 'heading', level: clampLevel(level + 1) }
  if (type === 'NUMBER') return { kind: 'list', ordered: true, level }
  if (type === 'BULLET') return { kind: 'list', ordered: false, level }
  return { kind: 'body' }
}

function readHeaderTables(xml: string): HeaderTables {
  const doc = parser.parse(xml) as XmlNode
  const head = (doc['hh:head'] ?? doc['head']) as XmlNode | undefined
  const refList = head?.['hh:refList'] as XmlNode | undefined

  const styleHeadingLevel = new Map<string, number>()
  const styleParaPr = new Map<string, string>()
  for (const style of asArray((refList?.['hh:styles'] as XmlNode | undefined)?.['hh:style'])) {
    const id = attr(style, 'id')
    if (id === undefined) continue
    const paraPrIdRef = attr(style, 'paraPrIDRef')
    if (paraPrIdRef !== undefined) styleParaPr.set(id, paraPrIdRef)
    const level =
      headingLevelFromStyleName(attr(style, 'engName')) ??
      headingLevelFromStyleName(attr(style, 'name'))
    if (level !== null) styleHeadingLevel.set(id, level)
  }

  const paraPr = new Map<string, { role: ParagraphRole; align: ParagraphInfo['align'] }>()
  for (const pr of asArray((refList?.['hh:paraProperties'] as XmlNode | undefined)?.['hh:paraPr'])) {
    const id = attr(pr, 'id')
    if (id === undefined) continue
    paraPr.set(id, { role: roleOf(pr), align: alignOf(pr) })
  }

  return { styleHeadingLevel, styleParaPr, paraPr }
}

/**
 * Resolve one paragraph against the header tables.
 *
 * The named style wins over the paragraph properties: a paragraph carrying
 * `styleIDRef` for "Heading 2" is a level-2 heading even when its own paraPr
 * says outline level 5, because the style is what the author picked and the
 * paraPr is what the template happened to attach to it.
 */
function resolve(tables: HeaderTables, styleIdRef?: string, paraPrIdRef?: string): ParagraphInfo {
  const named = styleIdRef === undefined ? undefined : tables.styleHeadingLevel.get(styleIdRef)
  const ownProps = paraPrIdRef === undefined ? undefined : tables.paraPr.get(paraPrIdRef)
  // A paragraph that does not override paragraph properties inherits the ones
  // its style points at — that is where the role of an unmodified heading lives.
  const styleProps =
    styleIdRef === undefined
      ? undefined
      : tables.paraPr.get(tables.styleParaPr.get(styleIdRef) ?? '')
  const props = ownProps ?? styleProps

  if (named !== undefined) return { role: { kind: 'heading', level: named }, align: props?.align ?? null }
  return { role: props?.role ?? { kind: 'body' }, align: props?.align ?? null }
}

/**
 * Roles of every top-level block, in document order.
 *
 * Only the *direct* `hp:p` children of each section count. Paragraphs nested in
 * a table cell (`hp:tbl` → `hp:tr` → `hp:tc` → `hp:subList` → `hp:p`) are
 * deliberately not walked: the renderer emits a table as a single block, so
 * counting its cells would desynchronise every index after it.
 *
 * Returns an empty array when the package cannot be read at all, which callers
 * treat the same as a length mismatch — import without role recovery rather than
 * import with the wrong roles.
 */
export async function readParagraphInfo(bytes: Uint8Array): Promise<ParagraphInfo[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return []
  }

  const headerEntry = findEntry(zip, 'contents/header.xml')
  if (!headerEntry) return []
  let tables: HeaderTables
  try {
    tables = readHeaderTables(await headerEntry.async('string'))
  } catch {
    return []
  }

  const out: ParagraphInfo[] = []
  for (const entry of sectionEntries(zip)) {
    let section: XmlNode
    try {
      section = parser.parse(await entry.async('string')) as XmlNode
    } catch {
      return []
    }
    const sec = (section['hs:sec'] ?? section['sec']) as XmlNode | undefined
    for (const para of asArray(sec?.['hp:p'])) {
      out.push(resolve(tables, attr(para, 'styleIDRef'), attr(para, 'paraPrIDRef')))
    }
  }
  return out
}
