/**
 * Host-agnostic PDF editing.
 *
 * `applyPdfEdits` is bytes in / bytes out; `savePdf` pairs it with a
 * host-supplied `PdfBytesIo` so Electron (node:fs) and the browser (File System
 * Access) run the same editing code. Nothing in this package imports Electron,
 * node:fs or any DOM API.
 */
export { applyPdfEdits, extractPagesBytes, insertPdfBytes } from './edit.js'
export { savePdf } from './io.js'
export type { PdfBytesIo } from './io.js'
export type {
  DrawingInput,
  FormValueInput,
  MarkupInput,
  MarkupType,
  MetadataInput,
  PdfEditRequest,
  StampInput,
} from './types.js'
