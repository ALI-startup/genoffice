/** `.hwpx` bytes → plain text, for everything that wants the words and not the document. */
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/**
 * `preserveOrder` shape: every element is an object with one tag key holding its children in
 * document order, plus `:@` for its attributes when it has any.
 */
type OrderedNode = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  // Whitespace in a section is content: HWPX writes no indentation, so a text
  // node holding only spaces is a real run of spaces in the document.
  trimValues: false,
})

const asNodes = (value: unknown): OrderedNode[] =>
  Array.isArray(value) ? (value as OrderedNode[]) : []

/** Section parts in numeric order — `section10.xml` must not sort before `section2.xml`. */
function sectionEntries(zip: JSZip): JSZip.JSZipObject[] {
  const found: Array<{ index: number; entry: JSZip.JSZipObject }> = []
  zip.forEach((path, entry) => {
    const match = /(?:^|\/)contents\/section(\d+)\.xml$/i.exec(path)
    if (match && !entry.dir) found.push({ index: Number(match[1]), entry })
  })
  return found.sort((a, b) => a.index - b.index).map((f) => f.entry)
}

/** Text of one paragraph or cell, built up run by run and flushed as a line. */
interface Line {
  parts: string[]
}

/** Walk a subtree, appending its text to `line`. */
function walk(nodes: OrderedNode[], line: Line, inText: boolean): void {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') continue
      if (key === '#text') {
        if (inText) line.parts.push(String(value))
        continue
      }
      switch (key) {
        case 'hp:t':
          walk(asNodes(value), line, true)
          break
        // Structure that carries no text of its own but whose absence would be
        // felt: a tab is a column separator in a plain-text reading, and a line
        // break inside a paragraph is a line break.
        case 'hp:tab':
          line.parts.push('\t')
          break
        case 'hp:lineBreak':
          line.parts.push('\n')
          break
        case 'hp:tbl':
          walkTable(asNodes(value), line)
          break
        case 'hp:p':
          // A paragraph nested inside something already being read — a cell, a text box, a
          // footnote.
          if (line.parts.length > 0) line.parts.push('\n')
          walk(asNodes(value), line, false)
          break
        default:
          walk(asNodes(value), line, false)
      }
    }
  }
}

/** A table, as rows of tab-separated cells. */
function walkTable(nodes: OrderedNode[], out: Line): void {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') continue
      if (key !== 'hp:tr') {
        walkTable(asNodes(value), out)
        continue
      }
      const cells: string[] = []
      for (const cellNode of asNodes(value)) {
        for (const [cellKey, cellValue] of Object.entries(cellNode)) {
          if (cellKey !== 'hp:tc') continue
          const cell: Line = { parts: [] }
          walk(asNodes(cellValue), cell, false)
          cells.push(cell.parts.join('').replace(/\s+/g, ' ').trim())
        }
      }
      if (cells.some((cell) => cell.length > 0)) {
        if (out.parts.length > 0) out.parts.push('\n')
        out.parts.push(cells.join('\t'))
      }
    }
  }
}

/** Direct `hp:p` children of a section are the document's top-level blocks. */
function readSection(nodes: OrderedNode[], lines: string[]): void {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@' || key === '#text') continue
      if (key === 'hp:p') {
        const line: Line = { parts: [] }
        walk(asNodes(value), line, false)
        // Pushed even when empty: a blank paragraph is the document's own
        // spacing, and `hwpxToText` decides which of those to keep.
        lines.push(
          line.parts
            .join('')
            .replace(/[ \t]+\n/g, '\n')
            .trimEnd(),
        )
        continue
      }
      readSection(asNodes(value), lines)
    }
  }
}

/** Every word in a `.hwpx` package, one line per paragraph. */
export async function hwpxToText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const lines: string[] = []
  for (const entry of sectionEntries(zip)) {
    let parsed: OrderedNode[]
    try {
      parsed = parser.parse(await entry.async('string')) as OrderedNode[]
    } catch {
      // One unreadable section does not discard the ones that did parse.
      continue
    }
    readSection(asNodes(parsed), lines)
  }
  // Blank paragraphs at either end belong to the template rather than to the author — the package
  // this repo writes opens with one — so they are dropped.
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
