// html2hwpx ships plain CommonJS with no declarations. The reference is what
// carries the ambient module declaration to every consumer that compiles this
// source — apps/docs compiles the package directly, so a `types` entry in this
// package's own tsconfig would not reach it.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- there is no import form for an ambient module declaration
/// <reference path="../types/html2hwpx.d.ts" />
/**
 * The restricted HTML fragment → `.hwpx` bytes, in the browser as well as Node.
 *
 * `html2hwpx` exposes a one-call `HTMLtoHWPX`, and this module deliberately does
 * not use it. That entry point reads the HWPX style template off the library's
 * own package directory with `readdirSync`/`readFileSync` and hands back a Node
 * `Buffer` — and that template read is the *only* thing on the export path that
 * needs a filesystem. Everything else the library does is pure string work:
 * `HtmlToAst.parse` builds an AST and `HtmlToHwpx.process()` turns it into
 * section XML plus a rewritten header.
 *
 * So the package is assembled here instead, against a template baked into
 * `template-data.ts`. That buys three things:
 *
 *   - the exporter runs in a browser, which is what a web build needs;
 *   - no bundler has to be told to keep the library external so its
 *     `__dirname`-relative template stays reachable at runtime;
 *   - one code path serves both hosts, so there is no second implementation to
 *     keep in step.
 *
 * The one behaviour not carried over is embedded pictures: the library measures
 * those through a temp file, and the restricted fragment has no `<img>` to begin
 * with, so that path is never reached.
 */
import {
  TEMPLATE_CONTENT_HPF,
  TEMPLATE_HEADER_XML,
  TEMPLATE_PACKAGE_FILES,
  TEMPLATE_SECTION_PREAMBLE,
} from './template-data'

/**
 * Namespace declarations for the section part.
 *
 * The generated body only ever uses the `hp:` prefix, but this full set is what
 * `html2hwpx` itself writes: a document that declares more than it uses stays
 * valid, one that declares less does not.
 */
const SECTION_NAMESPACES = [
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
  'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page"',
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
].join(' ')

/**
 * Wrap a fragment as a standalone document.
 *
 * The charset declaration is load-bearing: the fragment is Korean far more often
 * than not, and the parser inside `html2hwpx` falls back to a single-byte
 * encoding without it, turning every Hangul syllable into replacement
 * characters.
 */
function wrapFragment(fragment: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>HWPX Document</title>
</head>
<body>
${fragment}
</body>
</html>`
}

/** base64 → bytes, using whichever decoder the host provides. */
function fromBase64(base64: string): Uint8Array {
  // `atob` is in every browser and in Node since v16; the Buffer branch exists
  // for any runtime that predates it, not as the primary path.
  if (typeof atob === 'function') {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/** Declare embedded pictures in the package manifest, as the library does. */
function withImageManifest(
  contentHpf: string,
  images: ReadonlyArray<{ name: string; ext: string; mime: string }>,
): string {
  if (images.length === 0) return contentHpf
  const items = images
    .map(
      (img) =>
        `<opf:item id="${img.name}" href="BinData/${img.name}.${img.ext}" media-type="${img.mime}" isEmbeded="1"/>`,
    )
    .join('')
  return contentHpf.replace('</opf:manifest>', `${items}</opf:manifest>`)
}

/**
 * Convert a restricted HTML fragment to a `.hwpx` package.
 *
 * Pictures are a Node-only capability, and deliberately not worked around: the
 * converter measures every image through a temp file, so an `<img>` in a browser
 * throws from inside the library. It never comes up in practice — the restricted
 * fragment has no `<img>` for the same reason the import side drops them — but
 * the parts are written when they do exist so the package is never malformed.
 *
 * Known losses, all of them the converter's and none of them recoverable here:
 * paragraph alignment, hyperlink targets (the text survives, the `href` does
 * not), font families, and `<br>` line breaks, which are dropped without a
 * separator so the text either side runs together. Headings, bold/italic/
 * underline, colour, size and tables do survive. `<ul>`/`<ol>` survive only as
 * indented paragraphs with the marker written into the text, which is why the
 * import side strips those markers instead of re-exporting them.
 *
 * Throws when the fragment cannot be converted; there is no partial package.
 */
export async function htmlToHwpx(fragment: string): Promise<Uint8Array> {
  // Loaded on first use: a session that never touches HWPX should not pay for
  // the converter, which is the larger half of this package's bundle weight.
  const [{ HtmlToAst, HtmlToHwpx }, { default: JSZip }] = await Promise.all([
    import('html2hwpx'),
    import('jszip'),
  ])

  const html = wrapFragment(fragment)
  const converter = new HtmlToHwpx({
    jsonAst: HtmlToAst.parse(html),
    headerXmlContent: TEMPLATE_HEADER_XML,
    htmlContent: html,
    basePath: null,
  })
  // `process()` must run before `getModifiedHeaderXml()`: converting the body is
  // what appends the character and paragraph properties the body then refers to.
  const body = converter.process()
  const header = converter.getModifiedHeaderXml()

  const zip = new JSZip()
  for (const [path, base64] of Object.entries(TEMPLATE_PACKAGE_FILES)) {
    zip.file(path, fromBase64(base64))
  }
  zip.file('Contents/header.xml', header)
  zip.file(
    'Contents/section0.xml',
    `<?xml version="1.0" encoding="utf-8"?>\n<hs:sec ${SECTION_NAMESPACES}>${TEMPLATE_SECTION_PREAMBLE}${body}</hs:sec>`,
  )

  // Pictures, if the converter found any. The body already references them by
  // `BinData/<name>.<ext>`, so writing the parts and the manifest entries is not
  // optional — omitting them would ship a package with dangling references
  // rather than one simply missing its images.
  zip.file('Contents/content.hpf', withImageManifest(TEMPLATE_CONTENT_HPF, converter.images))
  for (const image of converter.images) {
    zip.file(`BinData/${image.name}.${image.ext}`, image.data)
  }

  // `uint8array`, not `nodebuffer`: JSZip only offers the latter where `Buffer`
  // exists, and this runs in a browser too.
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
