/**
 * Post-generation layout QC helpers:  - mergeQcPages: which pages a generation run marks for QC  -
 * createSlideFixSkill: tool allowlist wraps the full slides skill without losing the executor
 */
import { describe, it, expect } from 'vitest'
import { mergeQcPages, createSlideFixSkill, isQcEnabled } from '../src/renderer/ai/slide-qc'
import type { DeckAccess } from '../src/renderer/ai/slides-skill'

const access: DeckAccess = {
  getSlides: () => [],
  getCurrent: () => 0,
  getSelectedIds: () => [],
  applySlide: () => {},
  applyDeck: () => {},
  fitWidthPx: 1280,
}

describe('mergeQcPages', () => {
  it('unions, dedupes and sorts the pages a run landed', () => {
    expect(mergeQcPages([3, 1], [2, 3])).toEqual([1, 2, 3])
  })

  it('an empty run leaves the pending set alone', () => {
    expect(mergeQcPages([1, 2], [])).toEqual([1, 2])
  })

  it('drops indexes that cannot name a page', () => {
    expect(mergeQcPages([], [-1, 0])).toEqual([0])
  })
})

describe('createSlideFixSkill', () => {
  it('exposes only read_slide and execute_slide_script', () => {
    const skill = createSlideFixSkill(access)
    expect(skill.tools.map((t) => t.name).sort()).toEqual(['execute_slide_script', 'read_slide'])
  })

  it('delegates execution to the slides executor (read_slide works)', async () => {
    const one: DeckAccess = {
      ...access,
      getSlides: () => [
        {
          widthPx: 1280,
          heightPx: 720,
          nodes: [],
        } as never,
      ],
    }
    const skill = createSlideFixSkill(one)
    const r = await skill.executeTool({ id: 't1', name: 'read_slide', input: { slideIndex: 0 } })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Canvas 1280×720px')
  })
})

describe('isQcEnabled', () => {
  it("localStorage 'ai-slides-qc'='0' is the kill switch", () => {
    localStorage.removeItem('ai-slides-qc')
    expect(isQcEnabled()).toBe(true)
    localStorage.setItem('ai-slides-qc', '0')
    expect(isQcEnabled()).toBe(false)
    localStorage.removeItem('ai-slides-qc')
  })
})
