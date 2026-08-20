/**
 * Type shim for @samugen/file-parse's browser entry point, for the same reason as
 * file-parse.d.ts beside it: the package ships TS source, and its dependency
 * @samugen/docx-engine does not compile under sheets' stricter options
 * (exactOptionalPropertyTypes / noUncheckedIndexedAccess). tsconfig paths point type
 * resolution here; the bundler still uses the real source at runtime.
 *
 * Reached only indirectly — @samugen/platform-web's default attachment extractor imports
 * it on first use — which is why it appeared the moment sheets gained a browser host.
 *
 * Keep in sync with packages/file-parse/src/browser.ts.
 */
export function docxToText(bytes: Uint8Array): Promise<string>
export function hwpxToText(bytes: Uint8Array): Promise<string>
export function pptxToText(bytes: Uint8Array): Promise<string>
export function xlsxToText(bytes: Uint8Array): Promise<string>
