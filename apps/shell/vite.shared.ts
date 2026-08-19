/**
 * Renderer build pieces for the shell's web build.
 *
 * `hostAlias` resolves the bare specifier `@host` to the host module, so the renderer
 * imports its host by name and never by path — `main.tsx` bootstraps from `@host` and
 * tsconfig maps the same specifier for `tsc`.
 *
 * Same arrangement as apps/docs/vite.shared.ts and apps/pdf/vite.shared.ts.
 */
import { resolve } from 'node:path'

/** Resolve `@host` to the host module; tsconfig.json maps the same specifier for `tsc`. */
export function hostAlias(): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, 'src/renderer/src/host-web.ts') }
}
