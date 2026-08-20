/**
 * Prove that a change touched comments and nothing else.
 *
 * Every changed file is run through esbuild's transform, which drops comments and
 * renders the code canonically. If the rendering is identical before and after,
 * the diff cannot have changed a statement.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
// esbuild is not a direct dependency; it comes in under vite, so it is reached by
// path rather than by specifier.
import { createRequire } from 'node:module'
const esbuild = createRequire(import.meta.url)(
  new URL('../node_modules/vite/node_modules/esbuild/lib/main.js', import.meta.url).pathname,
)

const base = process.argv[2] ?? 'HEAD'
const changed = execSync(`git diff --name-only ${base}`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)

const LOADERS = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.js': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
  '.css': 'css',
}

// Whitespace and syntax are minified but identifiers are not. Minification is what
// makes the rendering comment-blind (a plain transform keeps some comments), while
// `minifyIdentifiers` has to stay off: esbuild picks short names by source character
// frequency, which comment text contributes to — so renaming would report a
// comment-only edit as a code change.
const render = (source, loader) =>
  esbuild.transformSync(source, {
    loader,
    format: loader === 'css' ? undefined : 'esm',
    target: 'esnext',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: 'none',
  }).code

let checked = 0
const differing = []
const skipped = []
for (const file of changed) {
  const loader = LOADERS[extname(file)]
  if (!loader) {
    skipped.push(file)
    continue
  }
  let before
  try {
    before = execSync(`git show ${base}:${file}`, { encoding: 'utf8', maxBuffer: 1 << 28 })
  } catch {
    skipped.push(`${file} (new)`)
    continue
  }
  const after = readFileSync(file, 'utf8')
  try {
    if (render(before, loader) !== render(after, loader)) differing.push(file)
  } catch (error) {
    differing.push(`${file} (transform failed: ${error.message.split('\n')[0]})`)
  }
  checked += 1
}
console.log(`checked ${checked} file(s) against ${base}`)
if (skipped.length) console.log(`skipped (not transformable / new): ${skipped.length}`)
if (differing.length === 0) {
  console.log('OK — every checked file renders identically with comments stripped')
} else {
  console.log('CODE CHANGED in:')
  for (const f of differing) console.log('  ' + f)
  process.exitCode = 1
}
