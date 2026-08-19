/**
 * The `@page` rules a browser needs to print this document, derived from the
 * document's own section geometry.
 *
 * Why this exists at all: the Electron path never needed it. `printToPDF` is told
 * the paper size as an argument (`pageSize` in inches, `margins: 0`) and leaves
 * `preferCSSPageSize` at its default of false, so Chromium ignores CSS `@page`
 * entirely there. A browser has no such argument — `window.print()` takes none —
 * so the *only* channel for "this document is A4, print it on A4 with no extra
 * margin" is CSS. Without these rules the browser prints at whatever paper the
 * user's dialog defaults to, with its own ~0.4in margins, and every fixed-height
 * `.pv-page` spills onto a second sheet.
 *
 * Pure by design: this module builds a string. Installing it is App.tsx's job (a
 * plain `<style>` in the tree, alongside the doc/theme/column stylesheets it
 * already renders), which means the rules track the document with no imperative
 * DOM, no cleanup and no ordering hazard — and, importantly, they are in place
 * before any print starts, so the browser's own Ctrl+P is covered as well as the
 * in-app button.
 *
 * Mixed paper sizes are handled with CSS *named pages*: one `@page <name>` per
 * distinct size, and the matching `page: <name>` on each `.pv-page` (see
 * PaginationPreview). That is the browser's counterpart to the print-a-group /
 * merge-with-pdf-lib dance the Electron exporter performs, and it is worth being
 * exact about how far it goes:
 *
 *   - Chromium (Chrome, Edge) supports named pages, so each sheet prints at its
 *     own section's paper size.
 *   - Firefox and Safari do not implement the `page` property. There every sheet
 *     falls back to the unnamed `@page` rule, and that rule is deliberately the
 *     *bounding box* of every size in the document rather than the first
 *     section's. It has to be: a `.pv-page` is a fixed-height box, so a sheet
 *     taller than the paper does not shrink, it spills its last centimetre onto a
 *     second sheet — measured, not assumed (an A4 page under a Letter `@page`
 *     turns three preview pages into four printed ones). The bounding box costs a
 *     mixed document some blank paper around its smaller sections and costs a
 *     uniform document — every document with one page size, which is nearly all of
 *     them — exactly nothing, since there the bounding box *is* the page size.
 *
 * Nothing here runs in the Electron bundle: App.tsx renders the stylesheet only
 * when the host exposes a print port, and `DocsPlatform.print` is null on
 * Electron. The `page:` property that PaginationPreview sets is inert there —
 * verified against `printToPDF` with `preferCSSPageSize` off, where naming pages
 * changes neither the sheet count nor the sheet size.
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

/**
 * The `@page` name for one paper size.
 *
 * Derived from the size rather than from a section index on purpose: two sections
 * on the same paper must share a page name, or Chromium would insert a break
 * between them for the name change alone. Rounded to whole pixels so the name a
 * `.pv-page` carries and the name the rule declares are computed from the same
 * value the same way.
 */
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

/**
 * The paper every size in `sizes` fits inside.
 *
 * Only ever consumed by a browser that ignores named pages, and only interesting
 * when a document mixes paper — see the file header for why the widest and
 * tallest wins there instead of the first section's.
 */
export function boundingPaper(sizes: PaperSizePx[]): PaperSizePx | null {
  return sizes.reduce<PaperSizePx | null>(
    (box, size) =>
      box === null
        ? size
        : { width: Math.max(box.width, size.width), height: Math.max(box.height, size.height) },
    null,
  )
}

/**
 * The stylesheet text: an unnamed fallback rule plus one named rule per size.
 *
 * `margin: 0` on every rule is not a style choice — the docx page box already
 * carries the document's own margins as padding, exactly as the Electron exporter
 * relies on (`margins: { top: 0, ... }` there). It also suppresses the URL/date
 * headers Chromium and Firefox stamp on a printed page, which have no business in
 * an exported document.
 *
 * Empty string when there are no sections, so App.tsx renders no stylesheet at
 * all rather than an `@page` rule made up out of nothing.
 */
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
