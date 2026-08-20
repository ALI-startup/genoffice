/** The export path must not touch the filesystem. */
import { describe, expect, it, vi } from 'vitest'

/** Stand-in for a module a browser build resolves to a throwing shim. */
function forbidden(specifier: string): never {
  throw new Error(`export path touched ${specifier}, which a browser cannot provide`)
}

const fsTrap = new Proxy(
  {},
  {
    get: (_target, prop) => forbidden(`fs.${String(prop)}`),
  },
)

vi.mock('fs', () => ({ default: fsTrap, ...fsTrap }))
vi.mock('node:fs', () => ({ default: fsTrap, ...fsTrap }))
vi.mock('fs/promises', () => ({ default: fsTrap, ...fsTrap }))
vi.mock('node:fs/promises', () => ({ default: fsTrap, ...fsTrap }))
vi.mock('os', () => ({ default: fsTrap, ...fsTrap }))
vi.mock('node:os', () => ({ default: fsTrap, ...fsTrap }))

describe('export without a filesystem', () => {
  it('writes a package with every fs module trapped', async () => {
    const { htmlToHwpx } = await import('../src/write')
    const bytes = await htmlToHwpx(
      '<h1>보고서 제목</h1><p>본문 <strong>굵게</strong></p><ul><li>항목</li></ul>' +
        '<table><thead><tr><th>이름</th></tr></thead><tbody><tr><td>가</td></tr></tbody></table>',
    )
    // "PK" — a real zip came out the other side.
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('round-trips through the reader with every fs module trapped', async () => {
    const { htmlToHwpx } = await import('../src/write')
    const { hwpxToHtml } = await import('../src/read')
    const fragment = '<h1>제목</h1><p>본문</p><ul><li>항목</li></ul>'
    const { html } = await hwpxToHtml(await htmlToHwpx(fragment))
    expect(html).toBe(fragment)
  })

  it('produces bytes, not a Node Buffer', async () => {
    const { htmlToHwpx } = await import('../src/write')
    const bytes = await htmlToHwpx('<p>x</p>')
    // JSZip only offers `nodebuffer` where Buffer exists; the browser needs the
    // plain typed array, so the exact constructor matters.
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype)
  })
})
