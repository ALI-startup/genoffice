/** Saving a deck straight to a file, on a host that has files. */
import { buildSaveZip, type OpenedPptx } from './index'

/** Same output as `savePptx`, written straight to `filePath`. */
export async function savePptxToFile(opened: OpenedPptx, filePath: string): Promise<void> {
  const { createWriteStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')
  const source = buildSaveZip(opened).generateNodeStream({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    streamFiles: true,
  })
  await pipeline(source, createWriteStream(filePath))
}
