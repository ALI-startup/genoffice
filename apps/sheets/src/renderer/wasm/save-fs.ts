/**
 * The browser's scratch filesystem for a save: the engine's own, reached across the Worker.
 *
 * The counterpart of src/engine-node/save-fs-node.ts, and the reason the save pipeline in
 * gateway/xlsx-package-io.ts takes a filesystem instead of importing one. Everything the
 * pipeline does with paths — planning parts into files, extracting entries to read them back,
 * promoting a finished archive over its target — happens here inside the engine's WASI
 * filesystem, which is the only filesystem both sides of the Worker link can name.
 *
 * `promote` is the one operation with no counterpart. On disk it is an fsync and a rename,
 * which is what makes a desktop save crash-safe. A page has neither: the "target" is a path
 * in memory, and the bytes still have to be handed to the user through the File System Access
 * API afterwards. So it copies, and the durability question moves up a layer, where the file
 * port answers it by writing through a handle the user granted.
 */
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
      // A copy, and deliberately so — see the note above. The engine wrote the archive at
      // `temporary`; the page reads `target` afterwards to get the bytes it must persist.
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
