/**
 * Hangul documents, for the attachment path.
 *
 * A re-export rather than an implementation, because the extractor belongs with
 * the rest of the HWPX codec — @samugen/hwpx-convert owns the package format and
 * already carries the jszip + fast-xml-parser reading of it. What this module
 * adds is the *place*: `parseFileToText` and `./browser` both name one source for
 * "hwpx bytes → text", exactly as they do for docx and pptx, so a caller never
 * has to know which package a given format lives in.
 *
 * Taken from the `./text` subpath, not the package root. The root also exports
 * the writer, whose HWPX style template is a 700-line embedded string; a browser
 * bundle that only ever reads a document should not carry it.
 *
 * There is deliberately no `hwpToText`. `.hwp` is the HWP 5.0 binary and nothing
 * here can read it — it reaches this package's callers already converted, by the
 * service in services/hwp-convert.
 */
export { hwpxToText } from '@samugen/hwpx-convert/text'
