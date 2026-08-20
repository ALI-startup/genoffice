/** Host-agnostic PDF editing. */
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
