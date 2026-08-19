/**
 * Renderer build pieces for pdf's web build, including the pdfjs assets it copies.
 *
 * `hostAlias` resolves the bare specifier `@host` to the host module, so the renderer
 * imports its host by name and never by path — `main.tsx` bootstraps from `@host` and
 * tsconfig maps the same specifier for `tsc`.
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

/** Resolve `@host` to the host module; tsconfig.json maps the same specifier for `tsc`. */
export function hostAlias(): Record<string, string> {
  return { '@host': resolve(import.meta.dirname, 'src/renderer/host-web.ts') }
}
