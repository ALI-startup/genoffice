/**
 * Renderer build pieces shared by pdf's three Vite configs.
 *
 * There are three because there are three ways this renderer is built:
 *   - electron.vite.config.ts — the packaged Electron app.
 *   - vite.renderer.config.ts — the renderer-only dev server the shell embeds
 *     via PDF_RENDERER_URL for HMR. Still an Electron host.
 *   - vite.web.config.ts      — the browser build, with no Electron at all.
 *
 * `hostAlias` is the build-time seam: it resolves the bare specifier `@host` to
 * one host module per config, so the choice of host is made by the bundler and
 * not by a runtime check. The Electron bundle therefore cannot contain the File
 * System Access code and the web bundle cannot contain `window.pdfApi`.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { normalizePath } from 'vite'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(dirname(require.resolve('pdfjs-dist/package.json')))
// vite-plugin-static-copy globs require POSIX separators; join() breaks on Windows
const pdfjsDir = (sub: string) => normalizePath(join(pdfjsRoot, 'pdfjs-dist', sub))

/** Non-embedded CMaps/standard fonts (e.g. CJK) need pdfjs data dirs, shipped with renderer output */
export function pdfjsCopyTargets(): Array<{ src: string; dest: string }> {
  return [
    { src: pdfjsDir('cmaps'), dest: 'pdfjs' },
    { src: pdfjsDir('standard_fonts'), dest: 'pdfjs' },
    { src: pdfjsDir('wasm'), dest: 'pdfjs' },
  ]
}

/**
 * Resolve `@host` to one host module. tsconfig.json maps the same specifier to
 * host-electron.ts so `tsc` has something to check `main.tsx` against;
 * host-web.ts is checked separately because it annotates its export as
 * `CreatePdfPlatform`, so the two cannot drift.
 */
export function hostAlias(host: 'electron' | 'web'): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, `src/renderer/host-${host}.ts`) }
}
