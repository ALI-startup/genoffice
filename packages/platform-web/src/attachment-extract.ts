/** The default browser attachment extractor: bytes → text, or the reason it cannot be done. */
import {
  ATTACHMENT_TEXT_EXTS,
  type WebAttachmentExtractor,
  type WebAttachmentSource,
  type WebAttachmentText,
} from './attachments.js'
import type { WebHwpConvertPort } from './hwp-convert.js'

/** Formats a browser can extract text from itself, beyond plain text. */
const OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'hwpx'])

/** Formats a file dialog may still let through, with the reason each is refused. */
const UNSUPPORTED_EXTS: Record<string, string> = {
  pdf: 'PDF text extraction is not available in the browser build',
  ppt: 'legacy .ppt is not supported; save it as .pptx',
  xls: 'legacy .xls is not supported; save it as .xlsx',
}

/** Said when a `.hwp` arrives at a host with no converter behind it. */
const HWP_UNAVAILABLE = 'HWP conversion is not available here; save it as .hwpx'

export interface BrowserAttachmentExtractorOptions {
  /** Reaches the `.hwp` → `.hwpx` service. */
  hwp?: WebHwpConvertPort
}

/** UTF-8, and strict: a mis-decoded attachment would feed the model plausible nonsense. */
const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)

export function createBrowserAttachmentExtractor(
  options: BrowserAttachmentExtractorOptions = {},
): WebAttachmentExtractor {
  const hwp = options.hwp
  return {
    supports: (ext) =>
      ATTACHMENT_TEXT_EXTS.has(ext) || OFFICE_EXTS.has(ext) || (ext === 'hwp' && hwp !== undefined),
    async extract(file: WebAttachmentSource): Promise<WebAttachmentText> {
      const reason = UNSUPPORTED_EXTS[file.ext]
      if (reason) return { ok: false, error: `${file.name}: ${reason}` }
      if (file.ext === 'hwp' && !hwp)
        return { ok: false, error: `${file.name}: ${HWP_UNAVAILABLE}` }
      try {
        const bytes = await file.bytes()
        if (ATTACHMENT_TEXT_EXTS.has(file.ext)) return { ok: true, text: decodeUtf8(bytes) }
        const { docxToText, hwpxToText, pptxToText, xlsxToText } =
          await import('@samugen/file-parse/browser')
        switch (file.ext) {
          case 'docx':
            return { ok: true, text: await docxToText(bytes) }
          case 'pptx':
            return { ok: true, text: await pptxToText(bytes) }
          case 'xlsx':
            return { ok: true, text: await xlsxToText(bytes) }
          case 'hwpx':
            return { ok: true, text: await hwpxToText(bytes) }
          case 'hwp': {
            // Converted, then read as the package it became.
            const converted = await hwp!.toHwpx(bytes)
            if (!converted.ok) {
              return {
                ok: false,
                error: `${file.name}: ${converted.reason === 'unsupported' || converted.reason === 'unreachable' ? HWP_UNAVAILABLE : converted.error}`,
              }
            }
            return { ok: true, text: await hwpxToText(converted.bytes) }
          }
        }
        return { ok: false, error: `${file.name}: unsupported file type (.${file.ext})` }
      } catch (error) {
        return {
          ok: false,
          error: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }
}
