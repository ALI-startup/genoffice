/** `.hwpx` bytes → the restricted HTML fragment docs' editor imports. */
import { normalizeHwpxHtml, type BlockAlign } from './normalize'
import { readParagraphInfo } from './outline'

export interface HwpxImport {
  /** Restricted HTML fragment: `h1`–`h6`, `p`, `ul`/`ol`/`li`, inline marks, tables. */
  html: string
  /** Alignment per emitted top-level block; the fragment has nowhere to carry it. */
  align: BlockAlign
  /** Pictures the fragment cannot express, so the caller can report the loss. */
  droppedImages: number
}

/** Copy out a standalone `ArrayBuffer` for the reader. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Read a `.hwpx` package. */
export async function hwpxToHtml(bytes: Uint8Array): Promise<HwpxImport> {
  const { HwpxReader } = await import('neoali-hwpxjs')
  const reader = new HwpxReader()
  await reader.loadFromArrayBuffer(toArrayBuffer(bytes))
  // embedImages so the normaliser can count what it drops rather than see a
  // dangling reference; tableHeaderFirstRow so a leading header row arrives as
  // <th> and survives into the editor as a bold, shaded header row.
  const rendered = await reader.extractHtml({ embedImages: true, tableHeaderFirstRow: true })

  // Role recovery is best-effort by contract: a package whose header or sections
  // will not parse still imports, just without headings and lists.
  const info = await readParagraphInfo(bytes)
  return normalizeHwpxHtml(rendered, info)
}
