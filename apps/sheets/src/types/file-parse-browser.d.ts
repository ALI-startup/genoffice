/**
 * Type shim for @samugen/file-parse's browser entry point, for the same reason as file-parse.d.ts
 * beside it: the package ships TS source, and its dependency @samugen/docx-engine does not compile
 * under sheets' stricter options (exactOptionalPropertyTypes / noUncheckedIndexedAccess).
 */
export function docxToText(bytes: Uint8Array): Promise<string>
export function hwpxToText(bytes: Uint8Array): Promise<string>
export function pptxToText(bytes: Uint8Array): Promise<string>
export function xlsxToText(bytes: Uint8Array): Promise<string>
