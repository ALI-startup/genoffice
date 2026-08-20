/** Paragraph roles recovered straight from the HWPX package. */
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

/** Heading level from a style name. */
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

/** Section parts in body order. */
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
  for (const pr of asArray(
    (refList?.['hh:paraProperties'] as XmlNode | undefined)?.['hh:paraPr'],
  )) {
    const id = attr(pr, 'id')
    if (id === undefined) continue
    paraPr.set(id, { role: roleOf(pr), align: alignOf(pr) })
  }

  return { styleHeadingLevel, styleParaPr, paraPr }
}

/** Resolve one paragraph against the header tables. */
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

  if (named !== undefined)
    return { role: { kind: 'heading', level: named }, align: props?.align ?? null }
  return { role: props?.role ?? { kind: 'body' }, align: props?.align ?? null }
}

/** Roles of every top-level block, in document order. */
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
