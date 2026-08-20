/**
 * Shared document-state types and header/footer helpers used by App.tsx and
 * the extracted action modules (file-actions, review-actions, …).
 */
import type { HeaderFooter, HfPartInfo, ParsedDocFull } from '@samugen/docx-engine'

/** first-page / even-page header & footer variants */
export type HfVariantKey = 'headerFirst' | 'footerFirst' | 'headerEven' | 'footerEven'
export type HfVariantsState = Record<HfVariantKey, HeaderFooter | null>
export type HfView = 'default' | 'first' | 'even'

export const EMPTY_HF_VARIANTS: HfVariantsState = {
  headerFirst: null,
  footerFirst: null,
  headerEven: null,
  footerEven: null,
}

export interface DocState {
  parsed: ParsedDocFull
  /**
   * The open document's host-issued handle (a `DocumentRef` — see
   * renderer/platform.ts); null until a new document is saved for the first
   * time.
   *
   * Still named `filePath` because it is genuinely a path for its one remaining
   * non-seam consumer, `window.projectApi` (resolveChat / rebindChat), which is
   * main-process bookkeeping and not migrated yet. Treat it as opaque anyway:
   * store it, compare it, hand it back. Never split, parse or display it — use
   * `fileName`, which the host supplies.
   */
  filePath: string | null
  /** Display name, supplied by the host; the renderer never derives it from filePath. */
  fileName: string
  hash: string
  /**
   * What a save writes.
   *
   * `docx` for everything the editor models directly — the parsed document above
   * *is* a docx, whatever the file on disk is. `hwpx` for a document opened from
   * a Hangul package: the editing model is still the docx one, and only the
   * encoding on the way out differs, which is exactly why this is a field on the
   * document rather than a different kind of document.
   *
   * Absent means `docx`, so every existing caller keeps its meaning.
   */
  format?: 'docx' | 'hwpx'
  /** created from the built-in blank template (its numbering ids are known) */
  isBlank?: boolean
}

/** Pending numbering definitions to append (saved via SaveOptions.numbering) */
export interface PendingNumbering {
  newDefs: Array<{
    numId: string
    kind: 'bullet' | 'ordered'
    levels?: import('@samugen/docx-engine').CustomNumberingLevel[]
  }>
  restartNums: Array<{
    numId: string
    abstractNumId: string
    startOverrides: Record<number, number>
  }>
}

export function hfFromPart(part: HfPartInfo | null | undefined): HeaderFooter | null {
  if (!part || (!part.text && !part.hasPageNumber && part.paras.length === 0)) return null
  return {
    text: part.text,
    pageNumber: part.hasPageNumber,
    paras: part.paras.length > 0 ? part.paras : undefined,
  }
}

export function hfVariantsFromParsed(parsed: ParsedDocFull): HfVariantsState {
  return {
    headerFirst: hfFromPart(parsed.headerFirst),
    footerFirst: hfFromPart(parsed.footerFirst),
    headerEven: hfFromPart(parsed.headerEven),
    footerEven: hfFromPart(parsed.footerEven),
  }
}
