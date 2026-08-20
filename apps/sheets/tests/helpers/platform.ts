/** Install a fake host for a renderer test. */
import { setSheetsPlatform, type SheetsPlatform } from '../../src/renderer/platform'

export function installTestPlatform<T extends object>(api: T): T {
  setSheetsPlatform({
    workbook: api,
    file: api,
    window: api,
    language: api,
    ai: api,
    attachments: api,
    project: null,
    menu: api,
    pdfExport: api,
    search: api,
  } as unknown as SheetsPlatform)
  return api
}
