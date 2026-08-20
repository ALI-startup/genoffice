/** The default extractor's decisions about Hangul documents. */
import { describe, expect, it } from 'vitest'
import { createBrowserAttachmentExtractor } from '../src/attachment-extract'
import type { WebAttachmentSource } from '../src/attachments'
import type { HwpConvertResult, WebHwpConvertPort } from '../src/hwp-convert'

const source = (name: string, bytes = new Uint8Array([1, 2, 3])): WebAttachmentSource => ({
  name,
  ext: name.split('.').pop() ?? '',
  bytes: () => Promise.resolve(bytes),
})

const port = (result: HwpConvertResult): WebHwpConvertPort => ({
  available: () => Promise.resolve(result.ok),
  toHwpx: () => Promise.resolve(result),
})

describe('supports', () => {
  it('always offers .hwpx, which is read in the page', () => {
    expect(createBrowserAttachmentExtractor().supports('hwpx')).toBe(true)
  })

  it('offers .hwp only where a converter was wired in', () => {
    expect(createBrowserAttachmentExtractor().supports('hwp')).toBe(false)
    expect(
      createBrowserAttachmentExtractor({
        hwp: port({ ok: true, bytes: new Uint8Array() }),
      }).supports('hwp'),
    ).toBe(true)
  })

  it('still refuses the legacy binary Office formats, which nothing reads', () => {
    const extractor = createBrowserAttachmentExtractor({
      hwp: port({ ok: true, bytes: new Uint8Array() }),
    })
    expect(extractor.supports('ppt')).toBe(false)
    expect(extractor.supports('xls')).toBe(false)
  })
})

describe('extract, for .hwp', () => {
  it('names the fix when there is no converter at all', async () => {
    const result = await createBrowserAttachmentExtractor().extract(source('report.hwp'))

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toBe(
      'report.hwp: HWP conversion is not available here; save it as .hwpx',
    )
  })

  it('names the same fix when the service is reachable but has no converter', async () => {
    // A deployment problem reads identically to a missing service from here:
    // either way the user's next move is to save the file as .hwpx.
    const extractor = createBrowserAttachmentExtractor({
      hwp: port({ ok: false, reason: 'unsupported', error: 'no usable "java"' }),
    })
    const result = await extractor.extract(source('report.hwp'))

    expect(result.ok ? '' : result.error).toContain('save it as .hwpx')
    expect(result.ok ? '' : result.error).not.toContain('java')
  })

  it("reports a refused document with the converter's own message", async () => {
    const extractor = createBrowserAttachmentExtractor({
      hwp: port({ ok: false, reason: 'failed', error: 'Conversion failed: bad record' }),
    })
    const result = await extractor.extract(source('broken.hwp'))

    expect(result.ok ? '' : result.error).toBe('broken.hwp: Conversion failed: bad record')
  })

  it('reports an unreadable file as that file failing, not as an outage', async () => {
    const extractor = createBrowserAttachmentExtractor({
      hwp: port({ ok: false, reason: 'invalid', error: 'not an HWP 5.0 document' }),
    })
    const result = await extractor.extract(source('renamed.hwp'))

    expect(result.ok ? '' : result.error).toBe('renamed.hwp: not an HWP 5.0 document')
  })
})
