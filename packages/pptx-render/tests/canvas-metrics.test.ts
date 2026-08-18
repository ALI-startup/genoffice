/**
 * `CanvasMetrics` — the provider a browser host measures with.
 *
 * The context is a fake, and has to be: a real one is the browser's text engine, whose
 * numbers are not the same on two engines and are not this file's business. What is testable
 * — and is what the provider exists to get right — is the font string it asks with, that it
 * asks as few times as it can, and what it does when the engine cannot answer.
 */
import { describe, expect, it } from 'vitest'
import { CanvasMetrics, HeuristicMetrics, type TextMeasureResult } from '../src/metrics'

const STYLE = { fontFamily: 'Arial', fontSizePx: 20, bold: false, italic: false }

/** Records every font string it is asked with, and answers 10px per character. */
function fakeContext(box: Partial<TextMeasureResult> = {}) {
  const asked: { font: string; text: string }[] = []
  return {
    asked,
    context: {
      font: '',
      measureText(text: string): TextMeasureResult {
        asked.push({ font: this.font, text })
        return { width: text.length * 10, ...box }
      },
    },
  }
}

const WITH_BOX = { fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 6 }

describe('CanvasMetrics', () => {
  it('measures with the font string the renderer draws with', () => {
    const { asked, context } = fakeContext()
    const metrics = new CanvasMetrics(context)
    expect(metrics.measure('hello', STYLE)).toBe(50)
    expect(asked).toEqual([{ font: 'normal normal 20px Arial', text: 'hello' }])
  })

  it('carries bold and italic, and quotes a family with a space', () => {
    const { asked, context } = fakeContext()
    const metrics = new CanvasMetrics(context)
    metrics.measure('x', { ...STYLE, fontFamily: 'Times New Roman', bold: true, italic: true })
    expect(asked[0]!.font).toBe('bold italic normal 20px "Times New Roman"')
  })

  it('measures the whole stack the host maps a family onto', () => {
    const { asked, context } = fakeContext()
    const metrics = new CanvasMetrics(context, {
      familyStack: (family) => `${family}, PingFang SC, sans-serif`,
    })
    metrics.measure('x', STYLE)
    // The renderer draws with the stack, so a measurement of the bare family would be a
    // measurement of a font the user may never see.
    expect(asked[0]!.font).toBe('normal normal 20px Arial, "PingFang SC", sans-serif')
  })

  it('takes line metrics from the font box, once per font', () => {
    const { asked, context } = fakeContext(WITH_BOX)
    const metrics = new CanvasMetrics(context)
    expect(metrics.metrics(STYLE)).toEqual({ ascent: 18, descent: 6, lineHeight: 24 })
    expect(metrics.metrics(STYLE)).toEqual({ ascent: 18, descent: 6, lineHeight: 24 })
    expect(metrics.metrics({ ...STYLE, fontSizePx: 40 })).toBeTruthy()
    // Two fonts asked, not three measurements: the font box does not depend on the text.
    expect(asked.map((a) => a.font)).toEqual([
      'normal normal 20px Arial',
      'normal normal 40px Arial',
    ])
  })

  it('caches a width per font and text', () => {
    const { asked, context } = fakeContext()
    const metrics = new CanvasMetrics(context)
    metrics.measure('word', STYLE)
    metrics.measure('word', STYLE)
    metrics.measure('word', { ...STYLE, bold: true })
    expect(asked).toHaveLength(2)
  })

  it('drops the width cache at its bound and keeps answering', () => {
    const { asked, context } = fakeContext()
    const metrics = new CanvasMetrics(context, { cacheLimit: 2 })
    metrics.measure('a', STYLE)
    metrics.measure('b', STYLE)
    metrics.measure('c', STYLE)
    // 'a' was dropped with the rest of the cache, so it is measured again rather than lost.
    expect(metrics.measure('a', STYLE)).toBe(10)
    expect(asked).toHaveLength(4)
  })

  it('falls back for line metrics when the engine reports no font box', () => {
    const { context } = fakeContext()
    const heuristic = new HeuristicMetrics()
    const metrics = new CanvasMetrics(context)
    // Older engines omit fontBoundingBox*; guessing from the ascent alone would silently
    // change every line height, so the fallback provider answers instead.
    expect(metrics.metrics(STYLE)).toEqual(heuristic.metrics(STYLE))
  })

  it('falls back for a width when measuring throws', () => {
    const context = {
      font: '',
      measureText(): TextMeasureResult {
        throw new Error('no rendering context')
      },
    }
    const metrics = new CanvasMetrics(context)
    expect(metrics.measure('hello', STYLE)).toBe(new HeuristicMetrics().measure('hello', STYLE))
  })

  it('answers zero for empty text without asking the engine', () => {
    const { asked, context } = fakeContext()
    expect(new CanvasMetrics(context).measure('', STYLE)).toBe(0)
    expect(asked).toHaveLength(0)
  })
})
