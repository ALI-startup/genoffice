// html2hwpx ships plain CommonJS with no declarations.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- there is no import form for an ambient module declaration
/// <reference path="../types/html2hwpx.d.ts" />
/** The restricted HTML fragment → `.hwpx` bytes, in the browser as well as Node. */
import {
  TEMPLATE_CONTENT_HPF,
  TEMPLATE_HEADER_XML,
  TEMPLATE_PACKAGE_FILES,
  TEMPLATE_SECTION_PREAMBLE,
} from './template-data'

/** Namespace declarations for the section part. */
const SECTION_NAMESPACES = [
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
  'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page"',
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
].join(' ')

/** Wrap a fragment as a standalone document. */
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

/** Convert a restricted HTML fragment to a `.hwpx` package. */
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

  // Pictures, if the converter found any.
  zip.file('Contents/content.hpf', withImageManifest(TEMPLATE_CONTENT_HPF, converter.images))
  for (const image of converter.images) {
    zip.file(`BinData/${image.name}.${image.ext}`, image.data)
  }

  // `uint8array`, not `nodebuffer`: JSZip only offers the latter where `Buffer`
  // exists, and this runs in a browser too.
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
