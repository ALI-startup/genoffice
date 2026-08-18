/**
 * Saving a deck straight to a file, on a host that has files.
 *
 * Split out of index.ts, and the split is the point: this is the only module in
 * the package that names `node:fs`, so every other importer — including a browser
 * bundle of the whole engine — can never pull it in. index.ts used to hold this
 * behind `await import('node:fs')`, which reads as lazy but is not: a bundler
 * still has to resolve the specifier while building, and Vite fails the web build
 * on it. Reached through the package's `./node` subpath.
 *
 * The browser's equivalent is `savePptx` (a single `Uint8Array`) handed to a
 * `FileSystemFileHandle` or a download; it has no streaming option, and that is a
 * real limit rather than an oversight — see the memory note below.
 */
import { buildSaveZip, type OpenedPptx } from './index'

/**
 * Same output as `savePptx`, written straight to `filePath`.
 *
 * Prefer this for anything that lands on disk: `savePptx` has to assemble the whole
 * package into one contiguous buffer, which on a large deck fails outright with
 * "Array buffer allocation failed". Streaming keeps peak memory to a chunk at a
 * time. JSZip throws stream errors from inside its own scheduled callbacks, so the
 * stream's 'error' event — not just the returned promise — has to be handled or the
 * throw escapes as an uncaught exception and takes the process down.
 */
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
