import { describe, expect, it } from 'vitest'
import { createPlatformSlot, type Platform } from '../src/index'

/** Minimal stand-in; the slot never inspects the value it holds. */
type TestPlatform = Pick<Platform, never> & { tag: string }

describe('createPlatformSlot', () => {
  it('returns the installed platform', () => {
    const slot = createPlatformSlot<TestPlatform>('docs')
    const platform: TestPlatform = { tag: 'a' }
    slot.set(platform)
    expect(slot.get()).toBe(platform)
  })

  it('throws before set, naming the slot label', () => {
    const slot = createPlatformSlot<TestPlatform>('sheets')
    expect(() => slot.get()).toThrowError(/No platform implementation installed/)
    expect(() => slot.get()).toThrowError(/"sheets"/)
  })

  it('replaces the implementation on a second set', () => {
    const slot = createPlatformSlot<TestPlatform>('slides')
    const first: TestPlatform = { tag: 'first' }
    const second: TestPlatform = { tag: 'second' }
    slot.set(first)
    slot.set(second)
    expect(slot.get()).toBe(second)
  })

  it('keeps slots independent', () => {
    const docs = createPlatformSlot<TestPlatform>('docs')
    const pdf = createPlatformSlot<TestPlatform>('pdf')
    const docsPlatform: TestPlatform = { tag: 'docs' }

    docs.set(docsPlatform)

    // Setting one slot must not satisfy another.
    expect(docs.get()).toBe(docsPlatform)
    expect(() => pdf.get()).toThrowError(/"pdf"/)

    const pdfPlatform: TestPlatform = { tag: 'pdf' }
    pdf.set(pdfPlatform)
    expect(pdf.get()).toBe(pdfPlatform)
    expect(docs.get()).toBe(docsPlatform)
  })
})
