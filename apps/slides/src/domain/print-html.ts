/**
 * The printable document for a deck: slides, handouts, or notes pages.
 *
 * Moved out of the main process unchanged, because printing is one of the few things both
 * hosts really do and the output must not differ between them. Electron loads this HTML in a
 * hidden window and calls `webContents.print()` — its own page is the editor, so it cannot
 * print itself; a browser prints the same HTML from a frame.
 *
 * Pure string building: page geometry from the slide ratio, the slide images as data URLs,
 * and the `@page` rules that make a printout paginate. Nothing here touches a host.
 */
import type { PrintSlidesOp } from '../shared/ipc'

export function buildPrintHtml(op: PrintSlidesOp): string {
  const layout = op.layout ?? 'full'
  const ratio = op.widthPx / op.heightPx
  // Full page: page size matches the slide ratio; handouts/notes: A4 portrait holding multiple thumbnails
  const slideH = 7.5
  const slideW = Math.round(ratio * slideH * 1000) / 1000
  const isFull = layout === 'full'
  const pageW = isFull ? slideW : 8.27
  const pageH = isFull ? slideH : 11.69
  const perPage =
    layout === 'handout2' ? 2 : layout === 'handout3' ? 3 : layout === 'handout6' ? 6 : 1
  const esc = (x: string) =>
    x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

  let body: string
  if (isFull) {
    body = op.pngsBase64
      .map((b64) => `<div class="page"><img src="data:image/png;base64,${b64}"></div>`)
      .join('')
  } else if (layout === 'notes') {
    // Notes page: slide on top + notes text below
    body = op.pngsBase64
      .map(
        (b64, i) =>
          `<div class="page notes"><img src="data:image/png;base64,${b64}">` +
          `<div class="note">${esc(op.notes?.[i] ?? '').replace(/\n/g, '<br>')}</div></div>`,
      )
      .join('')
  } else {
    // Handouts: perPage thumbnails per page (with 3, ruled lines on the right for handwriting)
    const pages: string[] = []
    for (let i = 0; i < op.pngsBase64.length; i += perPage) {
      const cells = op.pngsBase64
        .slice(i, i + perPage)
        .map(
          (b64) =>
            `<div class="cell"><img src="data:image/png;base64,${b64}">` +
            (perPage === 3 ? '<div class="rules"></div>' : '') +
            '</div>',
        )
        .join('')
      pages.push(`<div class="page handout h${perPage}">${cells}</div>`)
    }
    body = pages.join('')
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${pageW}in ${pageH}in; margin: 0; }
html, body { margin: 0; padding: 0; font-family: -apple-system, 'Segoe UI', sans-serif; }
.page { width: ${pageW}in; height: ${pageH}in; overflow: hidden; page-break-after: always; box-sizing: border-box; }
.page:last-child { page-break-after: auto; }
.page > img { display: block; width: 100%; height: 100%; }
.page.handout { padding: 0.4in; display: flex; flex-direction: column; gap: 0.24in; }
.page.handout .cell { display: flex; gap: 0.2in; align-items: center; flex: 1; min-height: 0; }
.page.handout .cell img { border: 1px solid #bbb; object-fit: contain; max-height: 100%; }
.page.handout.h2 .cell img, .page.handout.h6 .cell img { width: 100%; height: auto; max-height: 100%; }
.page.handout.h3 .cell img { width: 55%; height: auto; }
.page.handout.h3 .rules {
  flex: 1; align-self: stretch;
  background: repeating-linear-gradient(#fff 0 0.28in, #ccc 0.28in calc(0.28in + 1px));
}
.page.handout.h6 { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; }
.page.notes { padding: 0.5in; display: flex; flex-direction: column; }
.page.notes img { width: 100%; height: auto; border: 1px solid #bbb; }
.page.notes .note { margin-top: 0.3in; font-size: 11pt; line-height: 1.5; white-space: pre-wrap; }
</style></head><body>${body}</body></html>`
  return html
}
