/** The byte I/O seam. */
import { applyPdfEdits } from './edit.js'
import type { PdfEditRequest } from './types.js'

export interface PdfBytesIo {
  /** The document's current bytes — the base the edits are applied onto. */
  read(): Promise<Uint8Array>
  /** Persist the edited bytes. Only ever called with a complete, valid document. */
  write(bytes: Uint8Array): Promise<void>
}

/** Apply the edits to the document's current bytes and write the result back. */
export async function savePdf(io: PdfBytesIo, request: PdfEditRequest): Promise<void> {
  const bytes = await applyPdfEdits(await io.read(), request)
  await io.write(bytes)
}
