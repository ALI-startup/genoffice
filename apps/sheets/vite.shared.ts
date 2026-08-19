/**
 * Renderer build pieces shared by sheets' Vite configs.
 *
 * `hostAlias` is the build-time seam: it resolves the bare specifier `@host` to one host
 * module per config, so the choice of host is made by the bundler rather than by a runtime
 * check. The Electron bundle therefore cannot contain browser file code, and a web bundle
 * cannot contain `window.desktopApi`.
 *
 * Same arrangement as apps/slides/vite.shared.ts, apps/docs' and apps/pdf's.
 */
import { resolve } from 'node:path'

/**
 * Resolve `@host` to one host module. tsconfig.json maps the same specifier to
 * host-electron.ts so `tsc` has something to check `main.tsx` against; a web host is
 * checked in its own right because it annotates its export as `CreateSheetsPlatform`, so
 * the two cannot drift.
 */
export function hostAlias(host: 'electron' | 'web'): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, `src/renderer/host-${host}.ts`) }
}
