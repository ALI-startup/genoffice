/** Ambient types for `html2hwpx`, which ships plain CommonJS with no declarations. */
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

    /** Convert the AST to the body of `Contents/section0.xml`. */
    process(): string

    /** The template header with the properties `process()` needed added to it. */
    getModifiedHeaderXml(): string

    /** Pictures found in the document. Always empty for a fragment with no `<img>`. */
    readonly images: ReadonlyArray<{ name: string; ext: string; mime: string; data: Uint8Array }>
  }
}
