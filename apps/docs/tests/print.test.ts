/**
 * Browser printing: the `@page` rules (src/renderer/print.ts) and the port that opens the dialog
 * (createWebDocsPrintPort).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SectionSettings } from '@samugen/docx-engine'
import { boundingPaper, paperSizesOf, printPageCss, printPageName } from '../src/renderer/print'
import { createWebDocsPrintPort } from '../src/renderer/platform-web'

/** US Letter and A4 in twips, the unit sectPr stores. */
const LETTER = { pageWidth: 12240, pageHeight: 15840 }
const A4 = { pageWidth: 11906, pageHeight: 16838 }
const LETTER_LANDSCAPE = { pageWidth: 15840, pageHeight: 12240 }

function section(size: { pageWidth: number; pageHeight: number }): SectionSettings {
  return {
    ...size,
    marginTop: 1440,
    marginBottom: 1440,
    marginLeft: 1800,
    marginRight: 1800,
  } as SectionSettings
}

describe('printPageName', () => {
  it('names a size, not a section, so equal paper shares one rule', () => {
    expect(printPageName({ width: 816, height: 1056 })).toBe(
      printPageName({ width: 816.2, height: 1055.8 }),
    )
  })

  it('separates portrait from landscape', () => {
    expect(printPageName({ width: 816, height: 1056 })).not.toBe(
      printPageName({ width: 1056, height: 816 }),
    )
  })

  it('is a usable CSS identifier', () => {
    expect(printPageName({ width: 816, height: 1056 })).toMatch(/^[a-zA-Z][\w-]*$/)
  })
})

describe('paperSizesOf', () => {
  it('collapses sections that share paper', () => {
    expect(paperSizesOf([section(LETTER), section(LETTER), section(LETTER)])).toHaveLength(1)
  })

  it('keeps section order, first section first', () => {
    const sizes = paperSizesOf([section(A4), section(LETTER), section(A4)])
    expect(sizes).toHaveLength(2)
    expect(printPageName(sizes[0]!)).toBe(printPageName({ width: 793.7333, height: 1122.5333 }))
  })

  it('is empty for a document with no sections', () => {
    expect(paperSizesOf([])).toEqual([])
  })
})

describe('boundingPaper', () => {
  it('takes the widest width and the tallest height, which need not be the same page', () => {
    expect(boundingPaper(paperSizesOf([section(A4), section(LETTER)]))).toEqual({
      width: 816,
      height: 1122.5333333333333,
    })
  })

  it('is the page itself when there is only one', () => {
    expect(boundingPaper(paperSizesOf([section(LETTER)]))).toEqual({ width: 816, height: 1056 })
  })

  it('is null when there is nothing to bound', () => {
    expect(boundingPaper([])).toBeNull()
  })
})

describe('printPageCss', () => {
  it('emits nothing when there is no page geometry to describe', () => {
    expect(printPageCss([])).toBe('')
  })

  it('makes the unnamed fallback big enough for every page', () => {
    // A4 is the taller paper, Letter the wider one, and a browser that ignores
    // named pages prints both under this one rule — so it has to clear both, or a
    // page taller than the sheet spills onto the next one.
    const css = printPageCss(paperSizesOf([section(A4), section(LETTER)]))
    expect(css.split('\n')[0]).toBe('@page { size: 8.5in 11.6931in; margin: 0 }')
  })

  it('leaves a single-paper document at exactly its own size', () => {
    expect(printPageCss(paperSizesOf([section(A4), section(A4)])).split('\n')[0]).toBe(
      '@page { size: 8.2681in 11.6931in; margin: 0 }',
    )
  })

  it('declares one named rule per distinct size', () => {
    const sizes = paperSizesOf([section(LETTER), section(LETTER_LANDSCAPE), section(LETTER)])
    const css = printPageCss(sizes)
    expect(css.match(/@page docs-paper-/g)).toHaveLength(2)
    for (const size of sizes) expect(css).toContain(`@page ${printPageName(size)} {`)
  })

  it('zeroes the page margin, because the docx page box already carries the margins', () => {
    const css = printPageCss(paperSizesOf([section(LETTER)]))
    for (const rule of css.split('\n')) expect(rule).toContain('margin: 0 }')
  })

  it('writes whole inches without trailing zeros', () => {
    expect(printPageCss(paperSizesOf([section(LETTER)]))).toContain('size: 8.5in 11in;')
  })
})

describe('createWebDocsPrintPort', () => {
  it('opens the print dialog and waits for the browser to finish with it', async () => {
    const printPage = vi.fn(() => window.dispatchEvent(new Event('afterprint')))
    await createWebDocsPrintPort(printPage).print()
    expect(printPage).toHaveBeenCalledTimes(1)
  })

  it('does not resolve while the dialog is still open', async () => {
    let finish = (): void => {}
    const port = createWebDocsPrintPort(() => {
      finish = () => window.dispatchEvent(new Event('afterprint'))
    })
    const settled = vi.fn()
    void port.print().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(settled).toHaveBeenCalled())
  })

  it('resolves on a cancelled print too — the caller cannot tell, and must not care', async () => {
    // `afterprint` fires whether the user printed or dismissed the dialog.
    await expect(
      createWebDocsPrintPort(() => window.dispatchEvent(new Event('afterprint'))).print(),
    ).resolves.toBeUndefined()
  })
})
