/**
 * Build-time configuration a browser bundle needs from this package: `neoali-hwpxjs`'s public
 * entry point statically imports `node:fs/promises`, which is a hard error in a browser
 * target, so the specifier is aliased to the reader module it re-exports.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Where the browser-safe reader lives inside the published package. */
const READER_ENTRY = '../../node_modules/neoali-hwpxjs/dist/lib/hwpxReader.js'

/** Vite `resolve.alias` entries required to bundle this package for a browser. */
export function hwpxBrowserAlias(): Record<string, string> {
  const reader = fileURLToPath(new URL(READER_ENTRY, import.meta.url))
  if (!existsSync(reader)) {
    throw new Error(
      `@samugen/hwpx-convert: neoali-hwpxjs' reader is not at ${READER_ENTRY}. ` +
        'The package layout changed — update hwpxBrowserAlias() in packages/hwpx-convert/vite.ts.',
    )
  }
  return { 'neoali-hwpxjs': reader }
}
