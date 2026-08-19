/**
 * Build the xlsx engine for the browser.
 *
 * The same crate the desktop sidecar is, compiled to `wasm32-wasip1` as a reactor module.
 * WASI rather than `wasm32-unknown-unknown` is the load-bearing choice: every command in the
 * protocol names a path, the engine opens files, extracts parts to a scratch directory and
 * writes archives, and under WASI all of that keeps working against a filesystem the host
 * provides. The alternative was a byte-oriented rewrite of that boundary — a second
 * implementation of seven thousand lines, to be kept in step forever.
 *
 * What this script does that `cargo build` alone cannot is find a WASI sysroot. Two of the
 * crate's transitive dependencies are C (bzip2 and zstd, reached through ironcalc's `zip`),
 * so clang needs libc headers for the target. It looks, in order, at:
 *
 *   1. `$WASI_SYSROOT` — set this to a wasi-sdk sysroot if you have one.
 *   2. /opt/wasi-sdk/share/wasi-sysroot — where wasi-sdk installs by default.
 *   3. Debian's `wasi-libc` package, whose headers and libs are split across /usr/include
 *      and /usr/lib rather than gathered under one root; a sysroot directory of symlinks is
 *      assembled for clang in that case.
 *
 * Usage: `npm run wasm:build -w @samugen/sheets`
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, symlinkSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')
const crate = join(app, 'native/xlsx-engine')
const TARGET = 'wasm32-wasip1'
const PROFILE = 'wasm-release'

/** Where the renderer imports the module from. Generated, and git-ignored. */
const OUTPUT = join(app, 'src/renderer/wasm/xlsx-sidecar.wasm')

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd: crate,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

function ensureTarget(): void {
  const installed = run('rustup', ['target', 'list', '--installed'])
  if (installed.split('\n').includes(TARGET)) return
  console.log(`[wasm] installing the ${TARGET} target`)
  run('rustup', ['target', 'add', TARGET])
}

/**
 * A directory clang will accept as `--sysroot`, or null when this machine has no WASI libc.
 *
 * Debian's package is the awkward case: it ships `/usr/include/wasm32-wasi` and
 * `/usr/lib/wasm32-wasi`, but clang looks for `<sysroot>/include` and
 * `<sysroot>/lib/<triple>`. A directory of symlinks bridges the two without copying a libc.
 */
function findSysroot(): string | null {
  const explicit = process.env.WASI_SYSROOT
  if (explicit && existsSync(join(explicit, 'include/stdlib.h'))) return explicit

  const sdk = '/opt/wasi-sdk/share/wasi-sysroot'
  if (existsSync(join(sdk, 'include/stdlib.h'))) return sdk

  const debianInclude = '/usr/include/wasm32-wasi'
  const debianLib = '/usr/lib/wasm32-wasi'
  if (existsSync(join(debianInclude, 'stdlib.h')) && existsSync(debianLib)) {
    const assembled = join(crate, 'target/wasi-sysroot')
    rmSync(assembled, { recursive: true, force: true })
    mkdirSync(join(assembled, 'lib'), { recursive: true })
    symlinkSync(debianInclude, join(assembled, 'include'))
    symlinkSync(debianLib, join(assembled, 'lib/wasm32-wasi'))
    return assembled
  }
  return null
}

const sysroot = findSysroot()
if (sysroot === null) {
  console.error(
    '[wasm] no WASI sysroot found. Install one of:\n' +
      '  • Debian/Ubuntu: apt-get install wasi-libc\n' +
      '  • wasi-sdk: https://github.com/WebAssembly/wasi-sdk/releases (then WASI_SYSROOT=…)\n' +
      'The C dependencies (bzip2, zstd, via ironcalc) need libc headers for the target.',
  )
  process.exit(1)
}

ensureTarget()
console.log(`[wasm] building with sysroot ${sysroot}`)
run(
  'cargo',
  ['build', '--profile', PROFILE, '--target', TARGET, '--lib'],
  // cc-rs reads the target-specific CFLAGS variable; the underscored triple is its spelling.
  { CFLAGS_wasm32_wasip1: `--sysroot=${sysroot}` },
)

const built = join(crate, `target/${TARGET}/${PROFILE}/xlsx_sidecar.wasm`)
mkdirSync(dirname(OUTPUT), { recursive: true })
copyFileSync(built, OUTPUT)
const megabytes = (statSync(OUTPUT).size / 1024 / 1024).toFixed(2)
console.log(`[wasm] wrote ${OUTPUT} (${megabytes} MB)`)
