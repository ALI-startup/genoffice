/**
 * Renderer build pieces shared by docs' three Vite configs.
 *
 * There are three because there are three ways this renderer is built:
 *   - electron.vite.config.ts — the packaged Electron app.
 *   - vite.renderer.config.ts — the renderer-only dev server the shell embeds
 *     via DOCS_RENDERER_URL for HMR. Still an Electron host.
 *   - vite.web.config.ts      — the browser build, with no Electron at all.
 *
 * `hostAlias` is the build-time seam: it resolves the bare specifier `@host` to
 * one host module per config, so the choice of host is made by the bundler and
 * not by a runtime check. The Electron bundle therefore cannot contain the File
 * System Access code and the web bundle cannot contain `window.desktop`.
 *
 * Same arrangement as apps/pdf/vite.shared.ts, minus the pdfjs data copying.
 */
import { resolve } from 'node:path'

/**
 * Resolve `@host` to one host module. tsconfig.json maps the same specifier to
 * host-electron.ts so `tsc` has something to check `main.tsx` against;
 * host-web.ts is checked separately because it annotates its export as
 * `CreateDocsPlatform`, so the two cannot drift.
 */
export function hostAlias(host: 'electron' | 'web'): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, `src/renderer/host-${host}.ts`) }
}
