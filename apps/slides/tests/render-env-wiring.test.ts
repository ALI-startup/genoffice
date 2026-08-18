/**
 * The Electron host's real rendering services, wired end to end.
 *
 * tests/domain-session.test.ts proves the session takes its services from
 * whoever installs them, with fakes. This proves the thing fakes cannot: that
 * `installSlidesRenderEnv()` — the one line at the top of `registerSlidesIpc` —
 * installs services that actually work, over the real `createSystemFontMetrics`
 * and the real TIFF decoder.
 *
 * Worth its own file because the failure it guards is silent and total: an env
 * whose `metrics` forwarder was wrong would make every deck lay out with
 * heuristic widths, or throw on the first measurement, and no unit test that
 * builds its own provider would notice. Only `electron` itself is mocked, and only
 * because session-state imports `BrowserWindow` for dialog parenting.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPptx } from '@genoffice/pptx-engine'

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
}))

/**
 * HarfBuzz is stubbed, and only because it cannot load here at all: `shaped-metrics`
 * imports the wasm through Vite's `?asset`, which resolves to a path Node then tries
 * to import as a module ("Cannot find package 'wasi_snapshot_preview1'"). That is a
 * pre-existing limit of running this module outside Electron — docs/web-migration.md
 * §5.3 flags the same two imports as needing work for a web build.
 *
 * Stubbing it leaves the part this file is about intact: `createSystemFontMetrics`
 * still builds its real FontRegistry, still resolves real font files with opentype.js,
 * and still measures through them. Complex-script shaping is the only thing skipped,
 * and `shapedMeasure` returning null is exactly what the production code already
 * handles by falling back to the opentype path.
 */
vi.mock('../src/main/shaped-metrics', () => ({
  initShapedMetrics: () => {},
  shapedMetricsReady: () => Promise.resolve(),
  shapedMeasure: () => null,
  shapedFamily: () => null,
  complexScriptOf: () => null,
  refineComplexWidths: () => Promise.resolve(),
}))

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(join(__dirname, '../../../packages/pptx-engine/tests/fixtures', name)),
  )

describe('installSlidesRenderEnv', () => {
  it('renders a real deck through the real system-font metrics', async () => {
    const { installSlidesRenderEnv } = await import('../src/main/session-state')
    const { buildAllRenderSlides } = await import('../src/domain/session')
    installSlidesRenderEnv()

    const opened = await openPptx(fixture('01_standard_business.pptx'))
    const slides = buildAllRenderSlides(opened, 960)

    expect(slides.length).toBe(opened.deck.slides.length)
    // Text was laid out, not skipped: glyph runs with real advances, which only
    // happens if the installed metrics answered.
    const runs = slides
      .flatMap((slide) => slide.nodes)
      .flatMap((node) => ('text' in node && node.text ? node.text.lines : []))
      .flatMap((line) => line.runs)
    expect(runs.length).toBeGreaterThan(0)
    expect(runs.some((run) => run.text.trim().length > 0 && run.widthPx > 0)).toBe(true)
  })

  it('is idempotent, because registerSlidesIpc may be reached more than once', async () => {
    const { installSlidesRenderEnv } = await import('../src/main/session-state')
    const { getFontMetrics } = await import('../src/domain/session')

    installSlidesRenderEnv()
    installSlidesRenderEnv()

    expect(
      getFontMetrics().measure('Slides', {
        fontFamily: 'Arial',
        fontSizePx: 24,
        bold: false,
        italic: false,
      }),
    ).toBeGreaterThan(0)
  })
})
