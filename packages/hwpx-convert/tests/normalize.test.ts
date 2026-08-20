/** Renderer HTML → restricted fragment. */
import { describe, expect, it } from 'vitest'
import { normalizeHwpxHtml } from '../src/normalize'
import type { ParagraphInfo } from '../src/outline'

const body = (): ParagraphInfo => ({ role: { kind: 'body' }, align: null })
const heading = (level: number, align: ParagraphInfo['align'] = null): ParagraphInfo => ({
  role: { kind: 'heading', level },
  align,
})
const list = (ordered: boolean, level = 0): ParagraphInfo => ({
  role: { kind: 'list', ordered, level },
  align: null,
})

/** A rendered paragraph: tokens split into spans the way the renderer splits them. */
const p = (text: string, style = 'margin-bottom:10pt'): string =>
  `<p style="${style}">${text
    .split(/(\s+)/)
    .filter(Boolean)
    .map((token) => `<span style="font-size:10pt">${token}</span>`)
    .join('')}</p>`

describe('normalizeHwpxHtml', () => {
  it('collapses the per-token span soup back into plain text', () => {
    const { html } = normalizeHwpxHtml(p('hello there world'), [body()])
    expect(html).toBe('<p>hello there world</p>')
  })

  it('promotes paragraphs the package reports as headings', () => {
    const input = p('제목') + p('본문')
    const { html } = normalizeHwpxHtml(input, [heading(2), body()])
    expect(html).toBe('<h2>제목</h2><p>본문</p>')
  })

  it('keeps the inline marks the restricted set allows', () => {
    const input = '<p><span>a </span><strong>b</strong><em>c</em><u>d</u><s>e</s><br><b>f</b></p>'
    const { html } = normalizeHwpxHtml(input, [body()])
    expect(html).toBe('<p>a <strong>b</strong><em>c</em><u>d</u><s>e</s><br><strong>f</strong></p>')
  })

  it('keeps hyperlinks that have a target and unwraps ones that do not', () => {
    const input = '<p><a href="https://example.com">x</a><a>y</a></p>'
    const { html } = normalizeHwpxHtml(input, [body()])
    expect(html).toBe('<p><a href="https://example.com">x</a>y</p>')
  })

  it('escapes text that would otherwise be read as markup', () => {
    const { html } = normalizeHwpxHtml('<p><span>a &lt; b &amp; "c"</span></p>', [body()])
    expect(html).toBe('<p>a &lt; b &amp; &quot;c&quot;</p>')
  })

  describe('lists', () => {
    it('rebuilds real list markup and strips the baked-in marker', () => {
      const input =
        p('• 항목 하나', 'padding-left:36pt') + p('• Item two', 'padding-left:36pt') + p('after')
      const { html } = normalizeHwpxHtml(input, [list(false), list(false), body()])
      expect(html).toBe('<ul><li>항목 하나</li><li>Item two</li></ul><p>after</p>')
    })

    it('strips numeric markers from ordered items', () => {
      const input = p('1. first', 'padding-left:36pt') + p('2. second', 'padding-left:36pt')
      const { html } = normalizeHwpxHtml(input, [list(true), list(true)])
      expect(html).toBe('<ol><li>first</li><li>second</li></ol>')
    })

    it('strips Korean 가나다 ordinals', () => {
      const input = p('가. 첫째', 'padding-left:36pt') + p('나. 둘째', 'padding-left:36pt')
      const { html } = normalizeHwpxHtml(input, [list(true), list(true)])
      expect(html).toBe('<ol><li>첫째</li><li>둘째</li></ol>')
    })

    it('nests a deeper level inside the item above it', () => {
      const input =
        p('1. one', 'padding-left:36pt') +
        p('• nested', 'padding-left:72pt') +
        p('2. two', 'padding-left:36pt')
      const { html } = normalizeHwpxHtml(input, [list(true, 0), list(false, 1), list(true, 0)])
      expect(html).toBe('<ol><li>one<ul><li>nested</li></ul></li><li>two</li></ol>')
    })

    it('merges into one list when the first item is deeper than a later one', () => {
      // The outermost list is not inside any <li>, even when its level is above
      // zero, so there is nothing to dedent into: it takes the shallower level and
      // keeps both items, rather than emitting a stray </li> or splitting in two.
      const input = p('• a', 'padding-left:72pt') + p('• b', 'padding-left:36pt')
      const { html, align } = normalizeHwpxHtml(input, [list(false, 1), list(false, 0)])
      expect(html).toBe('<ul><li>a</li><li>b</li></ul>')
      expect(align).toHaveLength(1)
    })

    it('keeps a nested list nested when its kind changes', () => {
      const input =
        p('• a', 'padding-left:36pt') +
        p('• b', 'padding-left:72pt') +
        p('1. c', 'padding-left:72pt')
      const { html, align } = normalizeHwpxHtml(input, [
        list(false, 0),
        list(false, 1),
        list(true, 1),
      ])
      // The <ol> replaces the <ul> at the same depth, still inside item "a", so
      // it is one top-level block rather than two.
      expect(html).toBe('<ul><li>a<ul><li>b</li></ul><ol><li>c</li></ol></li></ul>')
      expect(align).toHaveLength(1)
    })

    it('closes and reopens when the list kind changes at the same depth', () => {
      const input = p('• a', 'padding-left:36pt') + p('1. b', 'padding-left:36pt')
      const { html, align } = normalizeHwpxHtml(input, [list(false), list(true)])
      expect(html).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>')
      // Two sibling blocks came out of one run of list paragraphs; both need a slot.
      expect(align).toHaveLength(2)
    })

    it('infers a list when the package declares no list role', () => {
      // What the exporter produces: indented paragraphs with a literal marker
      // and no hh:heading of type BULLET or NUMBER anywhere in the package.
      const input = p('• a', 'padding-left:36pt') + p('• b', 'padding-left:36pt')
      const { html } = normalizeHwpxHtml(input, [body(), body()])
      expect(html).toBe('<ul><li>a</li><li>b</li></ul>')
    })

    it('infers nesting depth from the indent when guessing', () => {
      const input = p('• a', 'padding-left:36pt') + p('• b', 'padding-left:72pt')
      const { html } = normalizeHwpxHtml(input, [body(), body()])
      expect(html).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>')
    })

    it('does not mistake an unindented numbered sentence for a list', () => {
      const { html } = normalizeHwpxHtml(p('1. 서론은 다음과 같다'), [body()])
      expect(html).toBe('<p>1. 서론은 다음과 같다</p>')
    })

    it('does not eat the year of an indented date', () => {
      // The guess is the only evidence here, so a four-digit run must not read
      // as an ordinal — otherwise "2024. " is silently deleted.
      const { html } = normalizeHwpxHtml(p('2024. 5. 1. 회의록', 'padding-left:36pt'), [body()])
      expect(html).toBe('<p>2024. 5. 1. 회의록</p>')
    })

    it('leaves the text alone when a declared list item carries no marker', () => {
      const input = p('numbered by the app', 'padding-left:36pt')
      const { html } = normalizeHwpxHtml(input, [list(true)])
      expect(html).toBe('<ol><li>numbered by the app</li></ol>')
    })
  })

  describe('tables', () => {
    it('rebuilds a header row as thead/th and the rest as tbody/td', () => {
      const input =
        '<table class="hwpx-table" style="width:450pt">' +
        '<thead><tr><th style="width:100pt"><p style="x"><span>이름</span></p></th></tr></thead>' +
        '<tbody><tr><td><p><span>가</span></p></td></tr></tbody></table>'
      const { html } = normalizeHwpxHtml(input, [body()])
      expect(html).toBe(
        '<table><thead><tr><th><p>이름</p></th></tr></thead><tbody><tr><td><p>가</p></td></tr></tbody></table>',
      )
    })

    it('emits a headerless table entirely as tbody', () => {
      const input = '<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>'
      const { html } = normalizeHwpxHtml(input, [body()])
      expect(html).toBe('<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>')
    })
  })

  describe('positional safety', () => {
    it('drops empty paragraphs so alignment stays aligned with the emitted blocks', () => {
      const input = '<p style="margin-bottom:10pt"></p>' + p('real')
      const { html, align } = normalizeHwpxHtml(input, [body(), heading(1, 'center')])
      // Roles are indexed over the *source* blocks, so the second role still lands on the second
      // source paragraph even though the first produced nothing...
      expect(html).toBe('<h1>real</h1>')
      // ...while alignment is indexed over what was emitted, so it has one entry
      // rather than a leading hole that would shift it onto the wrong block.
      expect(align).toEqual(['center'])
    })

    it('carries alignment positionally over the emitted blocks', () => {
      const input = p('a') + p('b') + p('c')
      const { align } = normalizeHwpxHtml(input, [
        { role: { kind: 'body' }, align: 'center' },
        { role: { kind: 'body' }, align: null },
        { role: { kind: 'body' }, align: 'right' },
      ])
      expect(align).toEqual(['center', null, 'right'])
    })

    it('ignores the roles wholesale when they do not describe the same block count', () => {
      const input = p('a') + p('b')
      const { html } = normalizeHwpxHtml(input, [heading(1)])
      expect(html).toBe('<p>a</p><p>b</p>')
    })
  })

  it('drops images and counts them', () => {
    const input = '<p><span><img src="data:image/png;base64,AAAA"/></span>text</p>'
    const { html, droppedImages } = normalizeHwpxHtml(input, [body()])
    expect(html).toBe('<p>text</p>')
    expect(droppedImages).toBe(1)
  })
})
