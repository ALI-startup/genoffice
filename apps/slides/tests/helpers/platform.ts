/** Install a fake host for a renderer test. */
import { setSlidesPlatform, type SlidesPlatform } from '../../src/renderer/platform'

export function installTestPlatform<T extends object>(api: T): T {
  ;(window as unknown as { slidesApi: T }).slidesApi = api
  ;(window as unknown as { desktop: T }).desktop = api
  setSlidesPlatform({
    doc: api,
    file: api,
    window: api,
    language: api,
    ai: api,
    attachments: api,
    project: null,
    presenter: api,
    pdfExport: api,
    clipboard: api,
    search: api,
    menu: api,
  } as unknown as SlidesPlatform)
  return api
}
