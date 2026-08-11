import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { savePdf } from '../src/index.js'
import type { PdfBytesIo, PdfEditRequest } from '../src/index.js'

async function makePdf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const size of sizes) doc.addPage(size)
  return doc.save({ useObjectStreams: false })
}

const request = (over: Partial<PdfEditRequest> = {}): PdfEditRequest => ({
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...over,
})

const highlight = {
  pageIndex: 0,
  type: 'highlight' as const,
  color: [1, 0.87, 0.35] as [number, number, number],
  quads: [[10, 100, 60, 100, 10, 88, 60, 88]],
}

/** In-memory stand-in for a host's byte I/O; records every write. */
function memoryIo(source: Uint8Array): PdfBytesIo & { writes: Uint8Array[] } {
  const writes: Uint8Array[] = []
  return {
    writes,
    read: () => Promise.resolve(source),
    write: (bytes) => {
      writes.push(bytes)
      return Promise.resolve()
    },
  }
}

function annotSubtypes(doc: PDFDocument, pageIndex: number): string[] {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) return []
  return Array.from({ length: annots.size() }, (_, i) =>
    annots.lookup(i, PDFDict).lookup(PDFName.of('Subtype'), PDFName).decodeText(),
  )
}

describe('savePdf', () => {
  it('writes the edited bytes exactly once', async () => {
    const io = memoryIo(await makePdf([[612, 792]]))

    await savePdf(io, request({ markups: [highlight] }))

    expect(io.writes).toHaveLength(1)
    const out = await PDFDocument.load(io.writes[0]!)
    expect(annotSubtypes(out, 0)).toEqual(['Highlight'])
  })

  it('does not write when applying the edits fails', async () => {
    const io = memoryIo(await makePdf([[612, 792]]))

    // Unknown form field: pdf-lib throws before any bytes exist
    await expect(
      savePdf(io, request({ formValues: [{ name: 'missing', kind: 'text', value: 'x' }] })),
    ).rejects.toThrow()
    expect(io.writes).toHaveLength(0)
  })

  it('propagates a write failure to the caller', async () => {
    const io: PdfBytesIo = {
      read: async () => await makePdf([[612, 792]]),
      write: () => Promise.reject(new Error('disk full')),
    }

    await expect(savePdf(io, request({ markups: [highlight] }))).rejects.toThrow('disk full')
  })

  it('leaves the source bytes untouched (Save As reads source, writes elsewhere)', async () => {
    const source = await makePdf([[612, 792]])
    const before = Uint8Array.from(source)
    const io = memoryIo(source)

    await savePdf(io, request({ markups: [highlight] }))

    expect(source).toEqual(before)
    expect(io.writes[0]).not.toEqual(before)
  })
})
