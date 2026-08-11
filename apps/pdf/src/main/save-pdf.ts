/**
 * The Electron main process's byte I/O for PDF saving.
 *
 * The editing itself lives in @genoffice/pdf-edit and knows nothing about
 * files; this module supplies the node:fs half — read the source, write the
 * target atomically — and is all that stays behind here.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { savePdf } from '@genoffice/pdf-edit'
import type { PdfBytesIo } from '@genoffice/pdf-edit'
import type { SavePdfRequest } from '../shared/ipc'

/**
 * Byte I/O over the filesystem: read sourcePath, write targetPath atomically
 * (temp file next to the target + rename, so a mid-write crash can't corrupt
 * it; a failed write removes the temp file and rethrows).
 * The source file is only ever read: Save As (targetPath !== sourcePath) must never mutate
 * the original document, and a failed or cancelled save leaves both paths untouched.
 * In-place Save passes targetPath === sourcePath.
 */
export function createFsPdfBytesIo(sourcePath: string, targetPath: string): PdfBytesIo {
  return {
    read: async () => new Uint8Array(await readFile(sourcePath)),
    write: async (bytes) => {
      const tmp = `${targetPath}.gensave-${process.pid}.tmp`
      try {
        await writeFile(tmp, bytes)
        await rename(tmp, targetPath)
      } catch (err) {
        await rm(tmp, { force: true })
        throw err
      }
    },
  }
}

/** Apply the request to the PDF at sourcePath and write the result to targetPath. */
export async function savePdfToPath(
  sourcePath: string,
  targetPath: string,
  request: SavePdfRequest,
): Promise<void> {
  await savePdf(createFsPdfBytesIo(sourcePath, targetPath), request)
}
