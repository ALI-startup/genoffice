/**
 * Renderer build pieces shared by the shell's two Vite configs.
 *
 * There are two because there are two ways this renderer is built:
 *   - electron.vite.config.ts — the packaged Electron app (and its dev server).
 *   - vite.web.config.ts      — the browser build, with no Electron at all.
 *
 * `hostAlias` is the build-time seam: it resolves the bare specifier `@host` to
 * one host module per config, so the choice of host is made by the bundler and
 * not by a runtime check. The Electron bundle therefore cannot contain the frame
 * protocol or the routing, and the web bundle cannot contain a preload bridge.
 *
 * Same arrangement as apps/docs/vite.shared.ts and apps/pdf/vite.shared.ts.
 */
import { resolve } from 'node:path'

/**
 * Resolve `@host` to one host module. tsconfig.json maps the same specifier to
 * host-electron.ts so `tsc` has something to check `main.tsx` against;
 * host-web.ts is checked separately because it annotates its export as
 * `CreateShellPlatform`, so the two cannot drift.
 *
 * The update window is not part of this seam: `update.html` is Electron-only —
 * there is no updater in a browser — so update.ts imports its host by path.
 */
export function hostAlias(host: 'electron' | 'web'): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, `src/renderer/src/host-${host}.ts`) }
}
