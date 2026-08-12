/**
 * `.hwpx` bytes → the restricted HTML fragment docs' editor imports.
 *
 * Two passes over the same archive, because neither alone is enough:
 * `neoali-hwpxjs` turns the body into HTML but discards paragraph roles, and
 * `outline.ts` recovers the roles but not the text. `normalize.ts` joins them.
 */
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

/**
 * Copy out a standalone `ArrayBuffer` for the reader.
 *
 * A `Uint8Array` may be a view onto a larger pool — Node's `Buffer` usually is —
 * so handing over `.buffer` directly would give the reader the whole pool and it
 * would fail to recognise the zip. `slice` is a copy, which is also what keeps
 * the reader from seeing later mutations of the caller's array.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Read a `.hwpx` package.
 *
 * The reader is loaded on first use. Most documents are `.docx`, and in a
 * browser this is a separate chunk — a session that never opens a `.hwpx` should
 * not download the converter at all.
 *
 * Browser builds must alias the `neoali-hwpxjs` specifier; see this package's
 * `vite.ts` for what and why.
 *
 * Throws when the bytes are not a readable HWPX package — an encrypted or
 * corrupt file has no partial import worth showing.
 */
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
