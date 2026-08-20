/** The name tests, which four call sites used to each own a copy of. */
import { describe, expect, it } from 'vitest'
import { hwpxNameFor, isHangulName, isHwpName, isHwpxName } from '../src/formats'

describe('isHwpxName', () => {
  it('accepts the extension in any case', () => {
    expect(isHwpxName('report.hwpx')).toBe(true)
    expect(isHwpxName('REPORT.HWPX')).toBe(true)
  })

  it('rejects the legacy binary and everything else', () => {
    expect(isHwpxName('report.hwp')).toBe(false)
    expect(isHwpxName('report.docx')).toBe(false)
    expect(isHwpxName('hwpx')).toBe(false)
    expect(isHwpxName('report.hwpx.docx')).toBe(false)
  })
})

describe('isHwpName', () => {
  it('accepts only the legacy binary', () => {
    expect(isHwpName('report.hwp')).toBe(true)
    expect(isHwpName('REPORT.HWP')).toBe(true)
  })

  it('does not match a .hwpx, which is the whole point of the anchor', () => {
    expect(isHwpName('report.hwpx')).toBe(false)
  })
})

describe('isHangulName', () => {
  it('is either format, which is what a file dialog offers', () => {
    expect(isHangulName('report.hwp')).toBe(true)
    expect(isHangulName('report.hwpx')).toBe(true)
    expect(isHangulName('report.docx')).toBe(false)
  })
})

describe('hwpxNameFor', () => {
  it('renames the legacy binary', () => {
    expect(hwpxNameFor('report.hwp')).toBe('report.hwpx')
  })

  it('leaves a .hwpx alone rather than doubling the extension', () => {
    expect(hwpxNameFor('report.hwpx')).toBe('report.hwpx')
  })

  it('replaces some other extension instead of appending to it', () => {
    expect(hwpxNameFor('notes.txt')).toBe('notes.hwpx')
  })

  it('adds the extension to a name that has none', () => {
    expect(hwpxNameFor('report')).toBe('report.hwpx')
  })
})
