/**
 * The gateway's file-shaped operations: the ones that take a path, or a whole workbook in a
 * Buffer, and touch `node:fs` or `node:crypto` to do it.
 *
 * Split out of xlsx-gateway.ts when sheets gained a browser host. Nothing about them was
 * wrong; they simply cannot exist in a page, and leaving them in a module the browser build
 * imports made that build fail on `node:path` before it could fail on anything real. The
 * streaming save path — `planCellEditsToXlsx` and everything it reaches — stayed behind,
 * because that is the path both hosts run.
 *
 * `writeXlsxAtomically` and `mutateXlsxFile` have no callers today: they are the whole-file
 * save the streaming pipeline replaced. They are kept rather than deleted because they are
 * the reference for what "atomic" means here — write to a sibling, fsync, rename.
 */
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { applyPlanToXlsx, sha256, type XlsxMutation } from '../gateway/xlsx-gateway'
import type { ChangePlan } from '../domain/workbook.types'

export async function writeXlsxAtomically(path: string, buffer: Buffer): Promise<void> {
  const temporaryPath = join(dirname(path), `.${crypto.randomUUID()}.tmp.xlsx`)
  try {
    await writeFile(temporaryPath, buffer, { flag: 'wx' })
    const handle = await open(temporaryPath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, path)
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export async function mutateXlsxFile(
  path: string,
  expectedSha256: string,
  plan: ChangePlan,
  sheetNamesById: Readonly<Record<string, string>>,
): Promise<XlsxMutation> {
  const source = await readFile(path)
  if ((await sha256(source)) !== expectedSha256) {
    throw new Error('The workbook changed on disk after preview.')
  }
  const mutation = await applyPlanToXlsx(source, plan, sheetNamesById)
  await writeXlsxAtomically(path, mutation.buffer)
  return mutation
}
