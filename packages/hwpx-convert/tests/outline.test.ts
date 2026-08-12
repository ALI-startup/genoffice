/**
 * Role recovery, against packages assembled here rather than round-tripped
 * through the exporter.
 *
 * The exporter never writes an `hh:heading` of type BULLET or NUMBER and never
 * writes a non-left alignment, so a fixture built from it could not exercise the
 * paths that matter for real Hangul Word Processor files. These fixtures carry
 * the XML such a file carries.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { readParagraphInfo } from '../src/outline'

interface StyleSpec {
  id: number
  name: string
  engName: string
  paraPrIDRef: number
}

interface ParaPrSpec {
  id: number
  heading?: { type: 'OUTLINE' | 'NUMBER' | 'BULLET' | 'NONE'; level: number }
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY'
}

function headerXml(styles: StyleSpec[], paraPrs: ParaPrSpec[]): string {
  const styleXml = styles
    .map(
      (s) =>
        `<hh:style id="${s.id}" type="PARA" name="${s.name}" engName="${s.engName}" paraPrIDRef="${s.paraPrIDRef}" charPrIDRef="0"/>`,
    )
    .join('')
  const paraPrXml = paraPrs
    .map((p) => {
      const heading = p.heading
        ? `<hh:heading type="${p.heading.type}" idRef="0" level="${p.heading.level}"/>`
        : ''
      const align = `<hh:align horizontal="${p.align ?? 'LEFT'}" vertical="BASELINE"/>`
      return `<hh:paraPr id="${p.id}">${heading}${align}</hh:paraPr>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.5" secCnt="1">
<hh:refList>
<hh:styles itemCnt="${styles.length}">${styleXml}</hh:styles>
<hh:paraProperties itemCnt="${paraPrs.length}">${paraPrXml}</hh:paraProperties>
</hh:refList>
</hh:head>`
}

/** One `hp:p` per entry, in document order. */
function sectionXml(paras: Array<{ paraPrIDRef: number; styleIDRef: number; text?: string }>): string {
  const body = paras
    .map(
      (p) =>
        `<hp:p paraPrIDRef="${p.paraPrIDRef}" styleIDRef="${p.styleIDRef}"><hp:run charPrIDRef="0"><hp:t>${p.text ?? ''}</hp:t></hp:run></hp:p>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">${body}</hs:sec>`
}

async function buildPackage(header: string, sections: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/hwp+zip')
  zip.file('Contents/header.xml', header)
  for (const [name, xml] of Object.entries(sections)) zip.file(`Contents/${name}`, xml)
  return zip.generateAsync({ type: 'uint8array' })
}

const STYLES: StyleSpec[] = [
  { id: 0, name: '바탕글', engName: 'Normal', paraPrIDRef: 0 },
  { id: 1, name: '제목 1', engName: 'Heading 1', paraPrIDRef: 2 },
  { id: 2, name: '제목 2', engName: 'Heading 2', paraPrIDRef: 3 },
  { id: 10, name: '제목', engName: 'Title', paraPrIDRef: 11 },
]

const PARA_PRS: ParaPrSpec[] = [
  { id: 0, heading: { type: 'NONE', level: 0 } },
  { id: 2, heading: { type: 'OUTLINE', level: 0 } },
  { id: 3, heading: { type: 'OUTLINE', level: 1 } },
  { id: 11, heading: { type: 'NONE', level: 0 }, align: 'CENTER' },
  { id: 20, heading: { type: 'BULLET', level: 0 } },
  { id: 21, heading: { type: 'NUMBER', level: 0 } },
  { id: 22, heading: { type: 'NUMBER', level: 1 } },
  { id: 30, heading: { type: 'NONE', level: 0 }, align: 'RIGHT' },
  { id: 31, heading: { type: 'NONE', level: 0 }, align: 'JUSTIFY' },
]

describe('readParagraphInfo', () => {
  it('reads heading level from the named style', async () => {
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), {
      'section0.xml': sectionXml([
        { paraPrIDRef: 0, styleIDRef: 0, text: 'body' },
        { paraPrIDRef: 2, styleIDRef: 1, text: 'h1' },
        { paraPrIDRef: 3, styleIDRef: 2, text: 'h2' },
      ]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info.map((i) => i.role)).toEqual([
      { kind: 'body' },
      { kind: 'heading', level: 1 },
      { kind: 'heading', level: 2 },
    ])
  })

  it('maps Title to level 1 and reads its alignment', async () => {
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), {
      'section0.xml': sectionXml([{ paraPrIDRef: 11, styleIDRef: 10, text: 'title' }]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info[0]).toEqual({ role: { kind: 'heading', level: 1 }, align: 'center' })
  })

  it('falls back to the outline level when no style names a heading', async () => {
    // paraPr 3 is outline level 1; HWPX levels are zero-based, so this is <h2>.
    const bytes = await buildPackage(headerXml([STYLES[0]], PARA_PRS), {
      'section0.xml': sectionXml([{ paraPrIDRef: 3, styleIDRef: 99, text: 'x' }]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info[0].role).toEqual({ kind: 'heading', level: 2 })
  })

  it('reads bullet and numbered list roles with their levels', async () => {
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), {
      'section0.xml': sectionXml([
        { paraPrIDRef: 20, styleIDRef: 0, text: 'bullet' },
        { paraPrIDRef: 21, styleIDRef: 0, text: 'number' },
        { paraPrIDRef: 22, styleIDRef: 0, text: 'nested' },
      ]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info.map((i) => i.role)).toEqual([
      { kind: 'list', ordered: false, level: 0 },
      { kind: 'list', ordered: true, level: 0 },
      { kind: 'list', ordered: true, level: 1 },
    ])
  })

  it('reads right and justified alignment, and reports left as null', async () => {
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), {
      'section0.xml': sectionXml([
        { paraPrIDRef: 30, styleIDRef: 0 },
        { paraPrIDRef: 31, styleIDRef: 0 },
        { paraPrIDRef: 0, styleIDRef: 0 },
      ]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info.map((i) => i.align)).toEqual(['right', 'justify', null])
  })

  it('inherits the role from the style when the paragraph sets no properties of its own', async () => {
    // styleIDRef 1 points at paraPr 2 (outline level 0); the paragraph's own
    // paraPrIDRef is absent from the table, so the style's must be used.
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), {
      'section0.xml': sectionXml([{ paraPrIDRef: 404, styleIDRef: 1, text: 'h1' }]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info[0].role).toEqual({ kind: 'heading', level: 1 })
  })

  it('concatenates sections in numeric order, not lexical', async () => {
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), {
      'section0.xml': sectionXml([{ paraPrIDRef: 0, styleIDRef: 0, text: 'a' }]),
      'section9.xml': sectionXml([{ paraPrIDRef: 20, styleIDRef: 0, text: 'b' }]),
      'section10.xml': sectionXml([{ paraPrIDRef: 2, styleIDRef: 1, text: 'c' }]),
    })
    const info = await readParagraphInfo(bytes)
    expect(info.map((i) => i.role.kind)).toEqual(['body', 'list', 'heading'])
  })

  it('ignores paragraphs nested inside table cells', async () => {
    // The renderer emits a table as one block, so counting its cell paragraphs
    // would shift every index after it.
    const section = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">
<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run><hp:t>before</hp:t></hp:run></hp:p>
<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList>
  <hp:p paraPrIDRef="2" styleIDRef="1"><hp:run><hp:t>cell</hp:t></hp:run></hp:p>
</hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>
<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run><hp:t>after</hp:t></hp:run></hp:p>
</hs:sec>`
    const bytes = await buildPackage(headerXml(STYLES, PARA_PRS), { 'section0.xml': section })
    const info = await readParagraphInfo(bytes)
    expect(info).toHaveLength(3)
    expect(info.every((i) => i.role.kind === 'body')).toBe(true)
  })

  it('returns nothing rather than guessing when the package will not parse', async () => {
    expect(await readParagraphInfo(new Uint8Array([1, 2, 3]))).toEqual([])
    const noHeader = await buildPackage('', {})
    expect(await readParagraphInfo(noHeader)).toEqual([])
  })
})
