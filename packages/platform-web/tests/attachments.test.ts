/** The browser `AttachmentsPort`. */
import { describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  createWebAttachmentsPort,
  type WebAttachmentExtractor,
} from '../src/attachments'
import type { WebFile } from '../src/fs-access'

/** A `File` stand-in: the port is written against `WebFile`, and a real File satisfies it. */
function fakeFile(name: string, contents: string | Uint8Array = 'hello', size?: number): WebFile {
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents
  return {
    name,
    // Overridable so the size caps can be exercised without allocating 50MB.
    size: size ?? bytes.byteLength,
    // Required by `WebFile` for the document store's conflict check; attachments
    // are never written back, so this port never reads it.
    lastModified: 1_000,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }
}

/** An extractor that decodes UTF-8 and supports exactly the extensions given. */
function textExtractor(
  exts: string[] = ['txt', 'docx'],
  override?: Partial<WebAttachmentExtractor>,
): WebAttachmentExtractor {
  return {
    supports: (ext) => exts.includes(ext),
    extract: async (file) => ({ ok: true, text: new TextDecoder().decode(await file.bytes()) }),
    ...override,
  }
}

function portWith(
  files: WebFile[],
  extractor: WebAttachmentExtractor = textExtractor(),
  pick: (() => Promise<WebFile[] | null>) | undefined = undefined,
) {
  let refs = 0
  return createWebAttachmentsPort({
    pick: pick ?? (async () => files),
    extractor,
    newRef: () => `att-${++refs}`,
  })
}

describe('pickAttachments', () => {
  it('accepts what it can read and reports the metadata the chip needs', async () => {
    const port = portWith([fakeFile('notes.txt', 'hello world')])

    const result = await port.pickAttachments()

    expect(result).toEqual({
      accepted: [{ ref: 'att-1', name: 'notes.txt', ext: 'txt', sizeBytes: 11 }],
      rejected: [],
    })
    // No `location`: a picked File exposes no path, and inventing one would put a
    // fiction in the tooltip. The field is optional for exactly this host.
    expect(result!.accepted[0] && 'location' in result!.accepted[0]).toBe(false)
  })

  it('reports a dismissed dialog as null, which is not the same as picking nothing', async () => {
    const port = portWith([], textExtractor(), async () => null)

    await expect(port.pickAttachments()).resolves.toBeNull()
  })

  it('rejects a format no extractor supports, with a reason naming the file', async () => {
    const port = portWith([fakeFile('slides.key')])

    const result = await port.pickAttachments()

    expect(result!.accepted).toEqual([])
    expect(result!.rejected).toEqual(['slides.key: unsupported file type (.key)'])
  })

  it('rejects an oversized file rather than trying to read it', async () => {
    const port = portWith([fakeFile('huge.txt', 'x', ATTACHMENT_MAX_BYTES + 1)])

    const result = await port.pickAttachments()

    expect(result!.accepted).toEqual([])
    expect(result!.rejected[0]).toContain('larger than 50MB')
  })

  it('applies the tighter multimodal cap to images', async () => {
    const port = portWith([fakeFile('shot.png', 'x', ATTACHMENT_IMAGE_MAX_BYTES + 1)])

    const result = await port.pickAttachments()

    expect(result!.accepted).toEqual([])
    expect(result!.rejected[0]).toContain('image larger than 5MB')
  })

  it('accepts an image without asking the extractor about it', async () => {
    const extractor = textExtractor(['txt'], {
      extract: vi.fn(async () => ({ ok: false, error: 'images have no text' })),
    })
    const port = portWith([fakeFile('shot.png', 'PNG')], extractor)

    const result = await port.pickAttachments()

    expect(result!.accepted.map((meta) => meta.ext)).toEqual(['png'])
    expect(extractor.extract).not.toHaveBeenCalled()
  })
})

describe('refs', () => {
  it('are opaque: nothing in a ref exposes the file it stands for', async () => {
    const port = portWith([fakeFile('/deeply/secret/notes.txt', 'x')])

    const result = await port.pickAttachments()

    expect(result!.accepted[0]!.ref).toBe('att-1')
    expect(result!.accepted[0]!.ref).not.toContain('notes')
  })

  it('are host-issued: a ref this host never handed out is rejected, not silently dropped', async () => {
    const port = portWith([])

    const result = await port.addAttachments(['att-from-a-previous-page-load'])

    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual(['an attachment is no longer available; add the file again'])
  })
})

describe('refForFile', () => {
  it('holds any File with bytes, including a clipboard bitmap Electron could not name', async () => {
    const port = portWith([])

    const ref = await port.refForFile(fakeFile('image.png', 'PNG') as unknown as File)

    expect(ref).not.toBeNull()
    const added = await port.addAttachments([ref!])
    expect(added.accepted.map((meta) => meta.name)).toEqual(['image.png'])
  })

  it('returns null for an empty File, which is what a dropped directory looks like', async () => {
    const port = portWith([])

    await expect(
      port.refForFile(fakeFile('folder', new Uint8Array()) as unknown as File),
    ).resolves.toBeNull()
  })
})

describe('addPastedImage', () => {
  it('stores the bytes and accepts them as an image attachment', async () => {
    const port = portWith([])

    const result = await port.addPastedImage(new Uint8Array([1, 2, 3]).buffer, 'PNG')

    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]!.ext).toBe('png')
    expect(result.accepted[0]!.name).toMatch(/^pasted-\d{8}-\d{6}\.png$/)
    await expect(port.readAttachmentImage(result.accepted[0]!.ref)).resolves.toEqual({
      ok: true,
      base64: 'AQID',
      mime: 'image/png',
    })
  })

  it('refuses non-image bytes instead of inventing an extension', async () => {
    const port = portWith([])

    const result = await port.addPastedImage(new Uint8Array([1]).buffer, 'exe')

    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual(['pasted content is not an image (.exe)'])
  })
})

describe('readAttachment', () => {
  const held = async (contents: string, extractor?: WebAttachmentExtractor) => {
    const port = portWith([fakeFile('notes.txt', contents)], extractor)
    const result = await port.pickAttachments()
    return { port, ref: result!.accepted[0]!.ref }
  }

  it('pages the text and reports the totals the agent needs to continue', async () => {
    const { port, ref } = await held('abcdefghij')

    await expect(port.readAttachment(ref, 0, 4)).resolves.toEqual({
      ok: true,
      name: 'notes.txt',
      totalChars: 10,
      offset: 0,
      text: 'abcd',
    })
    await expect(port.readAttachment(ref, 8, 4)).resolves.toEqual({
      ok: true,
      name: 'notes.txt',
      totalChars: 10,
      offset: 8,
      text: 'ij',
    })
  })

  it('clamps an out-of-range offset instead of reporting a negative slice', async () => {
    const { port, ref } = await held('abc')

    await expect(port.readAttachment(ref, 99, 4)).resolves.toMatchObject({
      ok: true,
      offset: 3,
      text: '',
    })
  })

  it('extracts once and reuses the result', async () => {
    const extractor = textExtractor(['txt'], {
      extract: vi.fn(async () => ({ ok: true, text: 'once' })),
    })
    const { port, ref } = await held('once', extractor)

    await port.readAttachment(ref, 0, 4)
    await port.readAttachment(ref, 0, 4)

    expect(extractor.extract).toHaveBeenCalledTimes(1)
  })

  it('reports an extraction failure as a failure, never as empty text', async () => {
    const extractor = textExtractor(['txt'], {
      extract: async () => ({ ok: false, error: 'notes.txt: the file is not valid UTF-8' }),
    })
    const { port, ref } = await held('junk', extractor)

    // The distinction matters: empty text reads to the model as "this file says
    // nothing", and it would answer from that.
    await expect(port.readAttachment(ref, 0, 100)).resolves.toEqual({
      ok: false,
      name: 'notes.txt',
      error: 'notes.txt: the file is not valid UTF-8',
    })
  })

  it('fails with an actionable message for a ref this page no longer holds', async () => {
    const port = portWith([])

    const result = await port.readAttachment('att-gone', 0, 100)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('add the file again')
  })
})

describe('readAttachmentImage', () => {
  it('refuses a non-image attachment rather than returning bytes the caller would mislabel', async () => {
    const port = portWith([fakeFile('notes.txt', 'hello')])
    const added = await port.pickAttachments()

    await expect(port.readAttachmentImage(added!.accepted[0]!.ref)).resolves.toEqual({
      ok: false,
      error: 'notes.txt is not an image attachment',
    })
  })
})
