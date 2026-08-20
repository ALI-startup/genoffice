/**
 * The desktop's scratch filesystem for a save: `node:fs`, exactly as the save used to do it inline.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SaveFs } from '../gateway/xlsx-package-io'

export function createNodeSaveFs(): SaveFs {
  return {
    mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    join: (...parts) => join(...parts),
    temporaryNear: (target) => join(dirname(target), `.${randomUUID()}.tmp.xlsx`),
    writeFile: async (path, content) => {
      // The parent may be an extraction directory the pipeline named but never created.
      await mkdir(dirname(path), { recursive: true })
      if (typeof content === 'string') await writeFile(path, content, 'utf8')
      else await writeFile(path, content)
    },
    readText: (path) => readFile(path, 'utf8'),
    promote: async (temporary, target) => {
      const handle = await open(temporary, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    },
    remove: (path) => rm(path, { recursive: true, force: true }),
  }
}
