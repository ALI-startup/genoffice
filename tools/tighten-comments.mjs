/**
 * Collapse comments that span more lines than they need.
 *
 * Three transforms, all information-preserving — no sentence is dropped, only the
 * lines around it:
 *
 *   1. a one-paragraph JSDoc block becomes a single `/** … *\/` line
 *   2. a run of `//` lines forming one paragraph becomes one `//` line
 *   3. `*` padding lines at the start or end of a block go away
 *
 * A collapse only happens when the result fits Prettier's printWidth, so the
 * formatter has nothing to undo afterwards.
 *
 * Directives are left alone: eslint, ts-expect-error, prettier-ignore, triple-slash
 * references and region markers all mean something to a tool, and joining them
 * would change what that tool sees.
 *
 * Verify with tools/verify-comments-only.mjs, which proves the result renders
 * identically once comments are stripped.
 *
 * Usage: node tools/tighten-comments.mjs [--write] [paths...]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { extname } from 'node:path'

// esbuild is not a direct dependency; it comes in under vite, so it is reached by
// path rather than by specifier.
const esbuild = createRequire(import.meta.url)(
  new URL('../node_modules/vite/node_modules/esbuild/lib/main.js', import.meta.url).pathname,
)

const LOADERS = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.js': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
  '.css': 'css',
}

/**
 * Comment-blind rendering. Identifiers are deliberately not minified: esbuild picks
 * short names by source character frequency, which comment text contributes to.
 */
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

const PRINT_WIDTH = 100
const args = process.argv.slice(2)
const write = args.includes('--write')
/** Keep only the first paragraph of a block, cut to its opening sentence. */
const aggressive = args.includes('--first-sentence')
const paths = args.filter((a) => !a.startsWith('--'))

const files = (
  paths.length > 0
    ? execSync(`git ls-files ${paths.map((p) => `'${p}'`).join(' ')}`, { encoding: 'utf8' })
    : execSync("git ls-files '*.ts' '*.tsx' '*.mts' '*.mjs' '*.js' '*.jsx' '*.css'", {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      })
)
  .trim()
  .split('\n')
  .filter(Boolean)

/** Anything a tool reads rather than a person. */
const DIRECTIVE =
  /(eslint|@ts-|prettier-ignore|#region|#endregion|<reference|@license|@preserve|c8 ignore|v8 ignore|istanbul)/

const indentOf = (line) => line.slice(0, line.length - line.trimStart().length)

/** Greedy wrap to `width` columns. */
function wrap(text, width) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  return out
}

/** One `/** … *\/` line where it fits, otherwise the shortest wrapped block. */
function renderBlock(indent, marker, text) {
  const single = `${indent}${marker} ${text} */`
  if (single.length <= PRINT_WIDTH) return [single]
  return [
    `${indent}${marker}`,
    ...wrap(text, PRINT_WIDTH - indent.length - 3).map((part) => `${indent} * ${part}`),
    `${indent} */`,
  ]
}

/**
 * Paragraphs of a block comment's body, or null when it holds a directive.
 *
 * A blank `*` line separates paragraphs; padding at either end is dropped.
 */
function paragraphs(bodyLines) {
  const found = []
  let current = []
  for (const line of bodyLines) {
    const text = line
      .trim()
      .replace(/^\*\s?/, '')
      .trimEnd()
    if (DIRECTIVE.test(text)) return null
    if (text === '') {
      if (current.length > 0) found.push(current.join(' ').trim())
      current = []
      continue
    }
    current.push(text)
  }
  if (current.length > 0) found.push(current.join(' ').trim())
  return found.filter(Boolean)
}

/**
 * The first sentence of a paragraph, when the paragraph is long enough that only
 * its opening claim is wanted. Abbreviations and decimals are not sentence ends.
 */
function firstSentence(text) {
  const match = /^(.*?[.!?])(\s|$)/s.exec(text.replace(/\s+/g, ' '))
  if (!match) return text
  const candidate = match[1].trim()
  // A "sentence" that is only a few characters is an abbreviation, not an end.
  return candidate.length < 24 ? text : candidate
}

function tighten(source) {
  const lines = source.split('\n')
  const out = []
  let saved = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    const indent = indentOf(line)

    // 1 & 3 — a block comment on its own lines.
    if (/^\/\*\*?$/.test(trimmed) || /^\/\*\*? /.test(trimmed)) {
      let end = i
      while (end < lines.length && !lines[end].includes('*/')) end += 1
      if (end < lines.length && end > i) {
        const opener = trimmed.replace(/^\/\*\*?/, '').trim()
        const closer = lines[end]
          .trim()
          .replace(/\*\/$/, '')
          .replace(/^\*\s?/, '')
          .trim()
        const paras = paragraphs([
          ...(opener ? [` * ${opener}`] : []),
          ...lines.slice(i + 1, end),
          ...(closer ? [` * ${closer}`] : []),
        ])
        const marker = trimmed.startsWith('/**') ? '/**' : '/*'
        if (paras !== null && paras.length > 0) {
          // Everything after the first paragraph is rationale; the first paragraph
          // is what the reader needs, cut to its opening sentence when it rambles.
          const kept = aggressive ? firstSentence(paras[0]) : paras.length === 1 ? paras[0] : null
          if (kept !== null) {
            const replacement = renderBlock(indent, marker, kept)
            if (replacement.length < end - i + 1) {
              out.push(...replacement)
              saved += end - i + 1 - replacement.length
              i = end
              continue
            }
          }
        }
      }
    }

    // 2 — a run of `//` lines that is one paragraph.
    if (/^\/\/ /.test(trimmed) && !DIRECTIVE.test(trimmed)) {
      let end = i
      while (
        end + 1 < lines.length &&
        /^\/\/ /.test(lines[end + 1].trim()) &&
        indentOf(lines[end + 1]) === indent &&
        !DIRECTIVE.test(lines[end + 1])
      ) {
        end += 1
      }
      if (end > i) {
        const joined = lines
          .slice(i, end + 1)
          .map((l) =>
            l
              .trim()
              .replace(/^\/\/\s?/, '')
              .trim(),
          )
          .join(' ')
        const text = aggressive ? firstSentence(joined) : joined
        const replacement = wrap(text, PRINT_WIDTH - indent.length - 3).map(
          (part) => `${indent}// ${part}`,
        )
        if (replacement.length < end - i + 1) {
          out.push(...replacement)
          saved += end - i + 1 - replacement.length
          i = end
          continue
        }
      }
    }

    out.push(line)
  }

  return { source: out.join('\n'), saved }
}

/**
 * Does the tightened source still describe the same program?
 *
 * The transform is line-based, so comment-shaped text inside a template literal is
 * a real hazard — `generate-template.ts` emits a JSDoc block as a string, and no
 * lexical guard short of a parser tells that apart from a comment (backtick parity
 * is defeated by a backtick inside a regex). So each file is checked instead of
 * guessed at: esbuild renders both versions with comments and whitespace stripped,
 * and a file whose rendering moves is left alone.
 */
function sameCode(file, before, after) {
  const loader = LOADERS[extname(file)]
  if (!loader) return false
  try {
    return render(before, loader) === render(after, loader)
  } catch {
    // Unparsable by esbuild (a `.d.ts` oddity, an unusual syntax level): not
    // provable, so not rewritten.
    return false
  }
}

let totalSaved = 0
let touched = 0
const refused = []
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  const { source, saved } = tighten(before)
  if (saved === 0 || source === before) continue
  if (!sameCode(file, before, source)) {
    refused.push(file)
    continue
  }
  totalSaved += saved
  touched += 1
  if (write) writeFileSync(file, source)
}
console.log(
  `${write ? 'rewrote' : 'would rewrite'} ${touched} file(s), ${totalSaved} fewer comment line(s)`,
)
if (refused.length > 0) {
  console.log(`left alone (comment-shaped text is code there): ${refused.length}`)
  for (const file of refused) console.log('  ' + file)
}
