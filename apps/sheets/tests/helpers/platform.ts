/**
 * Install a fake host for a renderer test.
 *
 * The renderer reaches its host through the platform slot (src/renderer/platform.ts), so a
 * test fills the slot rather than assigning `window.desktopApi`. One object backs every
 * port: they are `Pick`s of the same `DesktopApi`, so a partial stub satisfies all of them
 * structurally, and any member a test does not provide is simply never reached by the code
 * under test — the cast stands in for the rest of the composition instead of stubbing it.
 */
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
