/** The engine must run in a browser. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Stand-in for a module a browser build resolves to a throwing shim. */
function forbidden(specifier: string): never {
  throw new Error(`the engine reached ${specifier}, which a browser cannot provide`)
}

/** The shape a trapped module presents: any property access throws. */
function trap(name: string): Record<string, never> {
  return new Proxy({} as Record<string, never>, {
    get: (_target, prop) => forbidden(`${name}.${String(prop)}`),
  })
}

/** One module's mock. Written out per module rather than looped: `vi.mock` is hoisted. */
function shim(name: string): { default: Record<string, never> } {
  const trapped = trap(name)
  return { default: trapped, ...trapped }
}

vi.mock('fs', () => shim('fs'))
vi.mock('node:fs', () => shim('node:fs'))
vi.mock('fs/promises', () => shim('fs/promises'))
vi.mock('node:fs/promises', () => shim('node:fs/promises'))
vi.mock('os', () => shim('os'))
vi.mock('node:os', () => shim('node:os'))
vi.mock('path', () => shim('path'))
vi.mock('node:path', () => shim('node:path'))
vi.mock('zlib', () => shim('zlib'))
vi.mock('node:zlib', () => shim('node:zlib'))
vi.mock('crypto', () => shim('crypto'))
vi.mock('node:crypto', () => shim('node:crypto'))
vi.mock('stream', () => shim('stream'))
vi.mock('node:stream', () => shim('node:stream'))
vi.mock('node:stream/promises', () => shim('node:stream/promises'))
vi.mock('child_process', () => shim('child_process'))
vi.mock('node:child_process', () => shim('node:child_process'))

/** `Buffer` off the global object for the duration. */
const nodeBuffer = globalThis.Buffer
beforeAll(() => {
  Reflect.deleteProperty(globalThis, 'Buffer')
})
afterAll(() => {
  Object.defineProperty(globalThis, 'Buffer', {
    value: nodeBuffer,
    writable: true,
    configurable: true,
  })
})

describe('the engine without Node', () => {
  it('creates, opens, edits and saves a deck', async () => {
    const { createBlankPptx, openPptx, savePptx, addElement, commitSaved } =
      await import('../src/index')

    const blank = await createBlankPptx()
    const opened = await openPptx(blank)
    expect(opened.deck.slides.length).toBeGreaterThan(0)
    // A real sha256 came out of crypto.subtle rather than node:crypto.
    expect(opened.archive.originalHash).toMatch(/^[0-9a-f]{64}$/)

    addElement(opened.deck.slides[0]!, {
      kind: 'textbox',
      offset: { x: 914_400, y: 914_400, cx: 6_096_000, cy: 914_400 },
      paragraphs: [{ runs: [{ text: 'Browser', bold: true, fontSize: 40 }] }],
    })
    const saved = await savePptx(opened)
    commitSaved(opened)

    // "PK": a real zip, written without Buffer and without node:zlib.
    expect(saved[0]).toBe(0x50)
    expect(saved[1]).toBe(0x4b)

    // Reopened from the bytes this run produced: the parse side is exercised on
    // output the browser-safe save wrote, not on a fixture.
    const reopened = await openPptx(saved)
    const texts = reopened.deck.slides[0]!.elements.flatMap((el) =>
      'text' in el && el.text ? el.text.paragraphs : [],
    )
      .flatMap((p) => p.runs)
      .map((r) => r.text)
      .join('')
    expect(texts).toContain('Browser')
  })

  it('mints a section id, which used to come from node:crypto', async () => {
    const { createBlankPptx, openPptx, addSection, getSections, randomGuid } =
      await import('../src/index')
    const opened = await openPptx(await createBlankPptx())

    // `addSection` is the path that calls `newSectionId()` — the one wrapper around
    // `randomGuid` — so this covers the replacement rather than passing an id in.
    addSection(opened, 0, 'Intro')

    expect(getSections(opened).map((s) => s.name)).toContain('Intro')
    expect(getSections(opened).every((s) => /^\{[0-9A-F-]{36}\}$/.test(s.id))).toBe(true)
    expect(randomGuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/)
  })

  it('generates the poster png, which used to come from node:zlib', async () => {
    const { solidPng } = await import('../src/index')

    const png = solidPng(16, 9, [58, 58, 66])

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR immediately after the signature, then the stored-deflate IDAT.
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
    expect(png.byteLength).toBeGreaterThan(60)
  })
})
