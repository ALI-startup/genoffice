/**
 * The `@page` rules a browser needs to print this document, derived from the document's own section
 * geometry.
 */
import type { SectionSettings } from '@samugen/docx-engine'
import { sectionPageBox } from './pagination'

/**
 * A sheet's paper size in CSS pixels — the unit `sectionPageBox` reports and the
 * unit `.pv-page` is laid out in, so the two cannot drift apart.
 */
export interface PaperSizePx {
  width: number
  height: number
}

/** A CSS pixel is 1/96in by definition, which is what `@page size` wants. */
const PX_PER_INCH = 96

/** The `@page` name for one paper size. */
export function printPageName(size: PaperSizePx): string {
  return `docs-paper-${Math.round(size.width)}x${Math.round(size.height)}`
}

/** The distinct paper sizes of `sections`, in section order. */
export function paperSizesOf(sections: SectionSettings[]): PaperSizePx[] {
  const seen = new Set<string>()
  const sizes: PaperSizePx[] = []
  for (const settings of sections) {
    const { width, height } = sectionPageBox(settings)
    const size = { width, height }
    const name = printPageName(size)
    if (seen.has(name)) continue
    seen.add(name)
    sizes.push(size)
  }
  return sizes
}

/** The paper every size in `sizes` fits inside. */
export function boundingPaper(sizes: PaperSizePx[]): PaperSizePx | null {
  return sizes.reduce<PaperSizePx | null>(
    (box, size) =>
      box === null
        ? size
        : { width: Math.max(box.width, size.width), height: Math.max(box.height, size.height) },
    null,
  )
}

/** The stylesheet text: an unnamed fallback rule plus one named rule per size. */
export function printPageCss(sizes: PaperSizePx[]): string {
  const fallback = boundingPaper(sizes)
  if (fallback === null) return ''
  const box = (size: PaperSizePx) =>
    `size: ${inches(size.width)}in ${inches(size.height)}in; margin: 0`
  return [
    `@page { ${box(fallback)} }`,
    ...sizes.map((size) => `@page ${printPageName(size)} { ${box(size)} }`),
  ].join('\n')
}

/** Trailing zeros trimmed: `816` px is `8.5in`, not `8.5000in`. */
function inches(px: number): string {
  return (px / PX_PER_INCH).toFixed(4).replace(/\.?0+$/, '')
}
