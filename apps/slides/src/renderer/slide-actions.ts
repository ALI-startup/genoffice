/**
 * Slide- and section-level actions extracted from App.tsx:
 * add/duplicate/delete/cut slides, sections, and slide reorder. Element-level
 * clipboard lives in clipboard-actions.ts. Functions read the latest App
 * state through ActionCtx.
 */
import { slidesDeckClipboard } from './platform'
import { FIT_WIDTH } from './app-constants'
import type { ActionCtx } from './action-context'
import { renderSlidesToPngBase64 } from './export-render'
import { t } from './i18n/locale'
import { slidesDoc } from './platform'

export async function addSlide(ctx: ActionCtx): Promise<void> {
  if (!ctx.slide) return
  const r = await slidesDoc().addBlankSlide({
    sourceIndex: ctx.current,
    fitWidthPx: FIT_WIDTH,
  })
  if (r) {
    ctx.setSlides(r.slides)
    ctx.setCurrent(r.index)
    ctx.setSelectedIds([])
    ctx.setEditing(null)
    ctx.setDirty(true)
  }
}

export async function addSlideWithLayout(ctx: ActionCtx, layoutPath: string): Promise<void> {
  if (!ctx.slide) return
  const r = await slidesDoc().addSlideWithLayout({
    sourceIndex: ctx.current,
    layoutPath,
    fitWidthPx: FIT_WIDTH,
  })
  if (r) {
    ctx.setSlides(r.slides)
    ctx.setCurrent(r.index)
    ctx.setSelectedIds([])
    ctx.setEditing(null)
    ctx.setDirty(true)
  }
}

export async function duplicateSlideAt(ctx: ActionCtx, index: number): Promise<void> {
  const r = await slidesDoc().addSlide({
    sourceIndex: index,
    clearText: false,
    fitWidthPx: FIT_WIDTH,
  })
  if (r) {
    ctx.setSlides(r.slides)
    ctx.setCurrent(r.index)
    ctx.setSelectedIds([])
    ctx.setEditing(null)
    ctx.setDirty(true)
  }
}

export async function deleteSlideAt(ctx: ActionCtx, index: number): Promise<void> {
  const r = await slidesDoc().deleteSlide(index)
  if (r) {
    ctx.setSlides(r)
    ctx.setCurrent((c) => Math.min(c > index ? c - 1 : c, r.length - 1))
    ctx.setSelectedIds([])
    ctx.setEditing(null)
    ctx.setDirty(true)
  } else if (ctx.slides.length <= 1) {
    ctx.setStatus(t('appStatusKeepOneSlide'))
  }
}

export async function cutSlideAt(ctx: ActionCtx, index: number): Promise<void> {
  if (ctx.slides.length <= 1) {
    ctx.setStatus(t('appStatusKeepOneSlide'))
    return
  }
  let png: string | undefined
  try {
    const slide = ctx.slides[index]
    if (slide) [png] = await renderSlidesToPngBase64([slide], ctx.images)
  } catch {
    png = undefined
  }
  const ok = await slidesDeckClipboard().copySlide(index, png)
  if (!ok) {
    ctx.setStatus(t('appStatusSlideCopyFailed'))
    return
  }
  ctx.setCanPasteSlide(true)
  await deleteSlideAt(ctx, index)
  ctx.setStatus(t('appStatusSlideCut'))
}

// ── Section management ─────────────────────────────────────────────────

export async function addSectionAt(ctx: ActionCtx, index: number): Promise<void> {
  const r = await slidesDoc().addSection({
    atSlideIndex: index,
    name: t('appSectionUntitled'),
  })
  if (r) {
    ctx.setSections(r)
    ctx.setDirty(true)
    ctx.setStatus(t('appStatusSectionAdded'))
  }
}

export async function renameSectionTo(ctx: ActionCtx, id: string, name: string): Promise<void> {
  const r = await slidesDoc().renameSection({ id, name })
  if (r) {
    ctx.setSections(r)
    ctx.setDirty(true)
  }
}

export async function removeSectionAt(ctx: ActionCtx, id: string): Promise<void> {
  const r = await slidesDoc().removeSection({ id })
  if (r) {
    ctx.setSections(r)
    ctx.setDirty(true)
    ctx.setStatus(t('appStatusSectionRemoved'))
  }
}

export async function moveSectionDir(
  ctx: ActionCtx,
  id: string,
  dir: 'up' | 'down',
): Promise<void> {
  const r = await slidesDoc().moveSection({ id, dir })
  if (r) {
    ctx.setSlides(r.slides)
    ctx.setSections(r.sections)
    ctx.setSelectedIds([])
    ctx.setEditing(null)
    ctx.setDirty(true)
    ctx.setStatus(dir === 'up' ? t('appStatusSectionMovedUp') : t('appStatusSectionMovedDown'))
  }
}

export async function moveSlideTo(ctx: ActionCtx, from: number, insertAt: number): Promise<void> {
  const to = insertAt > from ? insertAt - 1 : insertAt
  if (to === from) return
  const r = await slidesDoc().moveSlide({ fromIndex: from, toIndex: to })
  if (r) {
    ctx.setSlides(r.slides)
    ctx.setSections(r.sections)
    ctx.setCurrent(to)
    ctx.setSelectedIds([])
    ctx.setEditing(null)
    ctx.setDirty(true)
    ctx.setStatus(t('appStatusSlideMoved', { page: to + 1 }))
  }
}

/** Commit section rename (Enter/blur); empty names aren't committed. */
export function commitRenameSection(ctx: ActionCtx): void {
  if (ctx.renamingSec && ctx.renamingSec.value.trim()) {
    void renameSectionTo(ctx, ctx.renamingSec.id, ctx.renamingSec.value.trim())
  }
  ctx.setRenamingSec(null)
}
