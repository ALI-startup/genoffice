/**
 * `.hwpx` bytes → plain text, for everything that wants the words and not the document.
 *
 * The AI panels' attachment path is the caller: a Korean report attached to a
 * question in slides or sheets has to reach the model as text, and those apps
 * have no document model to import it into. `hwpxToHtml` is the wrong tool there
 * — it pulls in `neoali-hwpxjs` to render display HTML and then a second pass to
 * recover paragraph roles, all of which is discarded on the way to a string.
 *
 * So this reads the package directly, with the jszip + fast-xml-parser pair
 * `outline.ts` already uses, and it is deliberately the *only* module here that
 * parses with `preserveOrder`. Order is the whole product: a paragraph's runs,
 * its tabs and its line breaks have to come out in the sequence they were
 * written, and the ordinary parse collapses same-named siblings into one array
 * per key, which loses the interleaving with everything between them.
 *
 * Table cells are walked, unlike in `outline.ts` where they are skipped on
 * purpose. The reason differs with the job: there, one line per *block* has to
 * stay aligned with the renderer's block count; here, the text inside a table is
 * exactly the text a reader wants.
 */
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

/**
 * `preserveOrder` shape: every element is an object with one tag key holding its
 * children in document order, plus `:@` for its attributes when it has any. Text
 * arrives as a `#text` key.
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

/**
 * Walk a subtree, appending its text to `line`.
 *
 * `inText` is what keeps stray whitespace out: only a `#text` inside an `hp:t`
 * is document text, and every other text node is XML formatting. Paragraphs met
 * along the way are separated by newlines rather than starting new lines of
 * their own, so a cell containing three paragraphs stays one cell.
 */
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
          // A paragraph nested inside something already being read — a cell, a
          // text box, a footnote. Separated, not flushed: the enclosing block
          // decides where lines begin.
          if (line.parts.length > 0) line.parts.push('\n')
          walk(asNodes(value), line, false)
          break
        default:
          walk(asNodes(value), line, false)
      }
    }
  }
}

/**
 * A table, as rows of tab-separated cells.
 *
 * Tabs rather than a rendered grid because the consumer is a model reading
 * prose, and tab-separated cells are the form it already reads spreadsheets in.
 */
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

/**
 * Every word in a `.hwpx` package, one line per paragraph.
 *
 * Throws when the bytes are not a zip at all — that is a file the caller handed
 * to the wrong reader, and reporting it is what lets the attachment path say so.
 * A package that opens but holds no readable section yields an empty string
 * instead: an encrypted or exotic document has no text to offer, which is not
 * the same as a broken input.
 */
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
  // Blank paragraphs at either end belong to the template rather than to the
  // author — the package this repo writes opens with one — so they are dropped.
  // Interior ones are kept: those are the document's own spacing, and losing
  // them runs separate sections of a report together.
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
