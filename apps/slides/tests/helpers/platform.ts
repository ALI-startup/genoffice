/**
 * Install a fake host for a renderer test.
 *
 * The renderer reaches its host through the platform slot (src/renderer/platform.ts), so
 * a test has to fill the slot rather than assign `window.slidesApi`. One object backs
 * every port: the ports are `Pick`s of the same `SlidesApi`, so a partial stub satisfies
 * all of them structurally, and any member a test does not provide is simply never
 * reached by the code under test — the cast stands in for the rest of the composition
 * instead of stubbing it.
 *
 * `window.slidesApi` is still assigned, and only for the tests' own assertions
 * (`expect((window as any).slidesApi.addChart).toHaveBeenCalled()`). No production code
 * reads it any more.
 */
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
    genspark: api,
    search: api,
    cloud: api,
    menu: api,
  } as unknown as SlidesPlatform)
  return api
}
