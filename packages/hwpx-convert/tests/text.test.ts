/**
 * Plain-text extraction, over packages this repo writes itself.
 *
 * The fixture is `htmlToHwpx`'s output for the same reason the round-trip suite
 * uses it: it is a real OWPML package, produced by the library the importer
 * reads, without a Hangul Word Processor file having to live in the repo.
 *
 * What is asserted is the shape a model receives — one line per paragraph, cells
 * tab-separated — because that is the contract the attachment path depends on
 * and the thing a parser change would silently alter.
 */
import { describe, expect, it } from 'vitest'
import { htmlToHwpx } from '../src/write'
import { hwpxToText } from '../src/text'

const textOf = async (fragment: string): Promise<string> => hwpxToText(await htmlToHwpx(fragment))

describe('hwpxToText', () => {
  it('reads Korean and Latin paragraphs, one line each', async () => {
    const text = await textOf('<p>안녕하세요.</p><p>Second paragraph.</p>')
    expect(text).toBe('안녕하세요.\nSecond paragraph.')
  })

  it('keeps heading and list text, without the markup', async () => {
    const text = await textOf(
      '<h1>보고서 제목</h1><p>본문</p><ul><li>항목 하나</li><li>Item two</li></ul>',
    )
    expect(text).toContain('보고서 제목')
    expect(text).toContain('항목 하나')
    expect(text).toContain('Item two')
    expect(text).not.toContain('<')
  })

  it('flattens inline marks into their text', async () => {
    const text = await textOf('<p>This is <strong>bold</strong> and <em>italic</em>.</p>')
    expect(text).toBe('This is bold and italic.')
  })

  it('reads table cells, tab-separated by row', async () => {
    const text = await textOf(
      '<table><thead><tr><th>이름</th><th>Value</th></tr></thead>' +
        '<tbody><tr><td>가</td><td>1</td></tr></tbody></table>',
    )
    const rows = text.split('\n').filter((line) => line.includes('\t'))
    expect(rows).toEqual(['이름\tValue', '가\t1'])
  })

  it('keeps paragraph order across the whole document', async () => {
    const text = await textOf(['<p>one</p>', '<p>two</p>', '<p>three</p>', '<p>four</p>'].join(''))
    expect(text.split('\n').filter(Boolean)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('rejects bytes that are not a package at all', async () => {
    // The attachment path reports this to the user, so it has to be a rejection
    // and not an empty string that reads as "this document has no words".
    await expect(hwpxToText(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
  })

  it('is empty for a package with nothing in it', async () => {
    expect((await textOf('<p></p>')).trim()).toBe('')
  })
})
