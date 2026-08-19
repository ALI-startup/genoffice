/**
 * The browser-safe half of this package.
 *
 * `./src/index.ts` cannot be imported by a browser bundle, and it is worth being
 * exact about why, because the parsers themselves are fine:
 *
 *   - `parse.ts` reads files off disk (`node:fs/promises`, `node:path`). Its whole
 *     interface is a file path, which a browser does not have.
 *   - `pdf.ts` uses `node:module`'s `createRequire` to locate pdfjs's
 *     standard-fonts directory on disk, and imports pdfjs's *Node* legacy build.
 *     Rollup fails the build outright on the `createRequire` import rather than
 *     merely warning, so a browser bundle cannot reach anything in the same module
 *     graph.
 *
 * The docx / pptx / xlsx extractors have neither problem: they take bytes and use
 * jszip + fast-xml-parser (+ @samugen/docx-engine, which already runs in the
 * docs renderer), all of which run unmodified in a browser. This entry point
 * exposes exactly those, so a web host reuses the same extraction the Electron
 * main process performs instead of growing a second implementation of it.
 *
 * PDF text extraction is deliberately absent: it needs a browser-side rewrite of
 * `pdf.ts` (pdfjs's web build plus a worker URL), not a re-export.
 */
export { docxToText } from './docx'
export { pptxToText } from './pptx'
export { xlsxToText } from './xlsx'
