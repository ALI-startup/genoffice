/**
 * Both codecs against each other, over a real `.hwpx` package.
 *
 * This is the closest thing to the actual import path that can run without a
 * Hangul Word Processor file in the repo, and it is what guards the property the
 * import is built around: a document that goes out and comes back must not gain
 * a second set of list markers. Everything else here records what the pair
 * genuinely preserves, so a library bump that changes it fails loudly instead of
 * degrading documents quietly.
 */
import { describe, expect, it } from 'vitest'
import { htmlToHwpx } from '../src/write'
import { hwpxToHtml } from '../src/read'

const FRAGMENT = [
  '<h1>보고서 제목</h1>',
  '<p>안녕하세요. This is <strong>bold</strong> and <em>italic</em>.</p>',
  '<h2>세부 사항</h2>',
  '<ul><li>항목 하나</li><li>Item two</li></ul>',
  '<ol><li>first</li><li>second</li></ol>',
  '<table><thead><tr><th>이름</th><th>Value</th></tr></thead><tbody><tr><td>가</td><td>1</td></tr></tbody></table>',
  '<p>Trailing paragraph.</p>',
].join('')

describe('hwpx round trip', () => {
  it('writes a package the reader can open', async () => {
    const bytes = await htmlToHwpx(FRAGMENT)
    // "PK" — the package is a zip, whatever else it contains.
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('preserves headings, lists, marks, tables and Korean text', async () => {
    const { html } = await hwpxToHtml(await htmlToHwpx(FRAGMENT))
    expect(html).toBe(
      '<h1>보고서 제목</h1>' +
        '<p>안녕하세요. This is <strong>bold</strong> and <em>italic</em>.</p>' +
        '<h2>세부 사항</h2>' +
        '<ul><li>항목 하나</li><li>Item two</li></ul>' +
        '<ol><li>first</li><li>second</li></ol>' +
        '<table><thead><tr><th><p>이름</p></th><th><p>Value</p></th></tr></thead>' +
        '<tbody><tr><td><p>가</p></td><td><p>1</p></td></tr></tbody></table>' +
        '<p>Trailing paragraph.</p>',
    )
  })

  it('does not accumulate list markers over repeated trips', async () => {
    // The failure this guards: the exporter writes a list item's bullet into the
    // text, so an importer that keeps it re-exports "• a" and gets "• • a" back.
    // Three trips is enough for a per-trip prefix to be unmistakable.
    let html = '<ul><li>항목</li></ul><ol><li>first</li></ol>'
    for (let i = 0; i < 3; i += 1) {
      html = (await hwpxToHtml(await htmlToHwpx(html))).html
    }
    expect(html).toBe('<ul><li>항목</li></ul><ol><li>first</li></ol>')
  })

  it('reports pictures it had to drop', async () => {
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bytes = await htmlToHwpx(`<p>before</p><p><img src="${png}" width="40" height="40"></p>`)
    const { droppedImages } = await hwpxToHtml(bytes)
    expect(droppedImages).toBeGreaterThan(0)
  })

  it('rejects bytes that are not an HWPX package', async () => {
    await expect(hwpxToHtml(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow()
  })
})
