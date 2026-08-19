/**
 * Renderer build pieces for docs' web build.
 *
 * `hostAlias` resolves the bare specifier `@host` to the host module, so the
 * renderer imports its host by name and never by path: `main.tsx` bootstraps from
 * `@host`, tsconfig maps the same specifier for `tsc`, and neither has to know
 * where the module lives. It is what made a second host possible and what keeps
 * host access in one file now that there is one.
 *
 * Same arrangement as apps/pdf/vite.shared.ts, minus the pdfjs data copying.
 */
import { resolve } from 'node:path'

/** Resolve `@host` to the host module; tsconfig.json maps the same specifier for `tsc`. */
export function hostAlias(): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, 'src/renderer/host-web.ts') }
}
