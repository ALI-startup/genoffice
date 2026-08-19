/**
 * Build-time configuration a browser bundle needs from this package.
 *
 * Only one thing, and it is not avoidable in the app's own config: the HWPX
 * *reader* is browser-safe, but the package that ships it is not reachable in a
 * browser through its public entry point. `neoali-hwpxjs`'s `dist/index.js`
 * re-exports a `.hwp` converter that does `import { readFile } from
 * 'node:fs/promises'` at the top level, and a named import of a Node builtin is
 * a hard build error in a browser target — Vite's browser shim satisfies
 * property access, not named bindings. The package declares no subpath in its
 * `exports` map either, so the reader cannot simply be imported directly.
 *
 * The alias resolves the specifier to the reader module itself, which pulls in
 * only jszip and fast-xml-parser, both of which run in a browser unchanged. The
 * `.hwp` converter is genuinely unused: this package reads `.hwpx` packages and
 * never the legacy binary format.
 *
 * Exported from here rather than written into each app's config so the reason
 * lives with the package, and so a version bump that moves the file fails at
 * config load with a clear message instead of at runtime with a missing export.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Where the browser-safe reader lives inside the published package. */
const READER_ENTRY = '../../node_modules/neoali-hwpxjs/dist/lib/hwpxReader.js'

/**
 * Vite `resolve.alias` entries required to bundle this package for a browser.
 *
 * Spread into the app's `resolve.alias`. Node targets (the Electron main
 * process) must *not* apply it: there the public entry point is correct, and
 * `node:fs` resolves normally.
 */
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
