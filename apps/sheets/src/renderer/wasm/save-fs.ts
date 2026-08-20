/** The browser's scratch filesystem for a save: the engine's own, reached across the Worker. */
import type { SaveFs } from '../../gateway/xlsx-package-io'
import type { XlsxWorkerClient } from './client'

/** Where saves work. Under the engine's scratch root, so a workbook's own directory is untouched. */
const SAVE_ROOT = '/tmp/save'

export function createEngineSaveFs(client: XlsxWorkerClient): SaveFs {
  let counter = 0
  const decoder = new TextDecoder()
  return {
    mkdtemp: async (prefix) => {
      // Created rather than merely named: the engine refuses to extract into a directory that
      // is not there, exactly as it would on disk.
      const path = `${SAVE_ROOT}/${prefix}${counter++}`
      await client.mkdir(path)
      return path
    },
    mkdir: (path) => client.mkdir(path),
    join: (...parts) => parts.join('/'),
    temporaryNear: (target) => `${SAVE_ROOT}/promote-${counter++}-${basename(target)}`,
    writeFile: async (path, content) => {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      await client.writeScratch(stripRoot(path), bytes)
    },
    readText: async (path) => decoder.decode(await client.readFile(path)),
    promote: async (temporary, target) => {
      // A copy, and deliberately so — see the note above.
      await client.writeScratch(stripRoot(target), await client.readFile(temporary))
    },
    // Nothing to reclaim eagerly: the whole filesystem goes away with the Worker, and a
    // failed remove during error handling would mask the error that caused it.
    remove: async () => {},
  }
}

/** `writeScratch` names paths relative to the engine's scratch root; this drops the prefix. */
function stripRoot(path: string): string {
  return path.startsWith('/tmp/') ? path.slice('/tmp/'.length) : path
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
