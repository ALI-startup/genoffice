/** Renderer build pieces shared by sheets' Vite configs. */
import { resolve } from 'node:path'

/** Resolve `@host` to the host module; tsconfig.json maps the same specifier for `tsc`. */
export function hostAlias(): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, 'src/renderer/host-web.ts') }
}
