/**
 * The default browser attachment extractor: bytes → text, or the reason it cannot be done.
 *
 * `createWebAttachmentsPort` takes an extractor rather than embedding one, because which
 * parsers a build carries is the app's decision. This is the answer every app has given so
 * far, so it lives here instead of being copied into each host — docs wrote it first and
 * slides needs exactly the same set.
 *
 * The office formats go through @samugen/file-parse's browser entry point — the same
 * extractors the path-based entry point runs, byte-for-byte, because they only ever needed
 * bytes and jszip / fast-xml-parser run in a browser unchanged. They are imported on first
 * use, so a session that attaches nothing never loads them.
 *
 * `.hwp` is the one format here that is not read in the page at all. It is the HWP 5.0
 * binary, which needs the converter service (see `./hwp-convert.ts`), so it is supported
 * exactly when a host hands this a convert port and rejected with something actionable
 * when it does not. That is why this factory takes options at all.
 */
import {
  ATTACHMENT_TEXT_EXTS,
  type WebAttachmentExtractor,
  type WebAttachmentSource,
  type WebAttachmentText,
} from './attachments.js'
import type { WebHwpConvertPort } from './hwp-convert.js'

/** Formats a browser can extract text from itself, beyond plain text. */
const OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'hwpx'])

/**
 * Formats a file dialog may still let through, with the reason each is refused.
 *
 * They are listed rather than silently missing so `addAttachments` can reject them with
 * something the user can act on, instead of accepting the file and failing later when the
 * model asks to read it.
 *
 *   - `pdf` — @samugen/file-parse's PDF extractor is Node-only: it locates pdfjs's
 *     standard-fonts directory with `createRequire` and imports pdfjs's Node legacy build,
 *     which a browser bundle cannot even build against. PDF text extraction *is* possible in
 *     a browser (pdfjs ships a web build), but it is a rewrite of that module rather than a
 *     reuse of it.
 *   - `ppt` / `xls` — the legacy binary Office formats. Nothing in the codebase parses them
 *     on any host: Electron accepts them at add time and then fails at read time, because
 *     `parseFileToText` has no case for them. Rejecting them up front is the same
 *     capability, reported earlier.
 */
const UNSUPPORTED_EXTS: Record<string, string> = {
  pdf: 'PDF text extraction is not available in the browser build',
  ppt: 'legacy .ppt is not supported; save it as .pptx',
  xls: 'legacy .xls is not supported; save it as .xlsx',
}

/** Said when a `.hwp` arrives at a host with no converter behind it. */
const HWP_UNAVAILABLE = 'HWP conversion is not available here; save it as .hwpx'

export interface BrowserAttachmentExtractorOptions {
  /**
   * Reaches the `.hwp` → `.hwpx` service. Given it, `.hwp` attachments are
   * accepted and converted on the way in; without it they are rejected up front
   * rather than accepted and failed later, which is the same rule `ppt` and
   * `xls` already follow here.
   */
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
            // Converted, then read as the package it became. The two steps are
            // one attachment from the user's side, so a conversion failure is
            // reported as this file failing rather than as a service error.
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
