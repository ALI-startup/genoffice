/**
 * The byte I/O seam.
 *
 * The editing logic (edit.ts) is pure pdf-lib and runs anywhere; what differs
 * per host is only how the document's bytes are read and written. Injecting
 * that as a two-method interface keeps a single implementation of "save":
 *
 *   - Electron main supplies a node:fs implementation (read the source file,
 *     write the target atomically via temp file + rename).
 *   - A browser host supplies a File System Access implementation (read via
 *     `FileSystemFileHandle.getFile()`, write via a writable stream).
 *
 * Which file is read and which is written is entirely the host's business: an
 * in-place save reads and writes the same document, while Save As reads the
 * source and writes a different destination. Nothing here needs to know.
 */
import { applyPdfEdits } from './edit.js'
import type { PdfEditRequest } from './types.js'

export interface PdfBytesIo {
  /** The document's current bytes — the base the edits are applied onto. */
  read(): Promise<Uint8Array>
  /** Persist the edited bytes. Only ever called with a complete, valid document. */
  write(bytes: Uint8Array): Promise<void>
}

/**
 * Apply the edits to the document's current bytes and write the result back.
 *
 * `write` is reached only when the whole edit applied cleanly: a failure inside
 * pdf-lib rejects before anything is written, so a failed save leaves the
 * destination as it was.
 */
export async function savePdf(io: PdfBytesIo, request: PdfEditRequest): Promise<void> {
  const bytes = await applyPdfEdits(await io.read(), request)
  await io.write(bytes)
}
