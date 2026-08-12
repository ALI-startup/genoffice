/**
 * Ambient types for `html2hwpx`, which ships plain CommonJS with no
 * declarations.
 *
 * Only the pure, filesystem-free half of the library is declared. The
 * convenience entry points it also exports (`HTMLtoHWPX`, `convertToHwpx`,
 * `HtmlRenderer`) all read the style template off the package directory, which
 * is exactly what `write.ts` avoids so the exporter can run in a browser — so
 * they are deliberately not surfaced here. Anything not declared cannot be
 * reached by accident.
 */
declare module 'html2hwpx' {
  /** Parsed representation of an HTML document; opaque to this package. */
  export type HtmlAst = unknown

  export const HtmlToAst: {
    /** Parse an HTML string. Pure — no filesystem access. */
    parse(htmlString: string): HtmlAst
  }

  export class HtmlToHwpx {
    constructor(options: {
      jsonAst: HtmlAst
      /** `Contents/header.xml` of the style template, as a string. */
      headerXmlContent: string
      htmlContent: string
      /** Directory that relative `<img src>` paths resolve against; null disables it. */
      basePath: string | null
    })

    /**
     * Convert the AST to the body of `Contents/section0.xml`.
     *
     * Must be called before `getModifiedHeaderXml`, which reports the character
     * and paragraph properties this pass appended.
     */
    process(): string

    /** The template header with the properties `process()` needed added to it. */
    getModifiedHeaderXml(): string

    /** Pictures found in the document. Always empty for a fragment with no `<img>`. */
    readonly images: ReadonlyArray<{ name: string; ext: string; mime: string; data: Uint8Array }>
  }
}
