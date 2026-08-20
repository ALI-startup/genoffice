/**
 * Element alignment and even distribution — pure geometry functions (no IO, no model dependencies).
 */

export interface AlignRect {
  x: number
  y: number
  w: number
  h: number
}

export type AlignKind = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'

export type DistributeKind = 'horizontal' | 'vertical'

// ── Internal helpers ────────────────────────────────────────────────────────

/** Axis-aligned bounding box */
function boundingBox(rects: AlignRect[]): AlignRect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Compute each element's new x/y coordinates after alignment. */
export function alignRects(
  rects: AlignRect[],
  kind: AlignKind,
  containerRect: AlignRect | null,
): Array<{ x: number; y: number }> {
  const box = containerRect ?? boundingBox(rects)

  return rects.map((r) => {
    let x = r.x
    let y = r.y
    switch (kind) {
      case 'left':
        x = box.x
        break
      case 'center-h':
        x = box.x + (box.w - r.w) / 2
        break
      case 'right':
        x = box.x + box.w - r.w
        break
      case 'top':
        y = box.y
        break
      case 'center-v':
        y = box.y + (box.h - r.h) / 2
        break
      case 'bottom':
        y = box.y + box.h - r.h
        break
    }
    return { x, y }
  })
}

/**
 * Compute each element's new x/y after even distribution (only the coordinate along the
 * distribution axis changes).
 */
export function distributeRects(
  rects: AlignRect[],
  kind: DistributeKind,
): Array<{ x: number; y: number }> {
  if (rects.length < 3) return rects.map((r) => ({ x: r.x, y: r.y }))

  if (kind === 'horizontal') {
    // Sort by left x to find the two ends
    const indexed = rects.map((r, i) => ({ r, i })).sort((a, b) => a.r.x - b.r.x)
    const first = indexed[0]!
    const last = indexed[indexed.length - 1]!
    const totalSpan = last.r.x + last.r.w - first.r.x
    const totalWidth = indexed.reduce((s, { r }) => s + r.w, 0)
    const gap = (totalSpan - totalWidth) / (rects.length - 1)
    const result: Array<{ x: number; y: number }> = rects.map((r) => ({ x: r.x, y: r.y }))
    let cursor = first.r.x
    for (const { r, i } of indexed) {
      result[i] = { x: cursor, y: rects[i]!.y }
      cursor += r.w + gap
    }
    return result
  } else {
    // Sort by top y
    const indexed = rects.map((r, i) => ({ r, i })).sort((a, b) => a.r.y - b.r.y)
    const first = indexed[0]!
    const last = indexed[indexed.length - 1]!
    const totalSpan = last.r.y + last.r.h - first.r.y
    const totalHeight = indexed.reduce((s, { r }) => s + r.h, 0)
    const gap = (totalSpan - totalHeight) / (rects.length - 1)
    const result: Array<{ x: number; y: number }> = rects.map((r) => ({ x: r.x, y: r.y }))
    let cursor = first.r.y
    for (const { r, i } of indexed) {
      result[i] = { x: rects[i]!.x, y: cursor }
      cursor += r.h + gap
    }
    return result
  }
}
