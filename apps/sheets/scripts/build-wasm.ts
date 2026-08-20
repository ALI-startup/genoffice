/** Build the xlsx engine for the browser. */
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

/** A directory clang will accept as `--sysroot`, or null when this machine has no WASI libc. */
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
