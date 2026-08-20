/** `.hwp` → `.hwpx`, by running the bundled converter. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default ceiling on one conversion, matching the Python driver's. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Where the vendored JAR lives, relative to this package. */
export const VENDORED_JAR = new URL('../vendor/hwp2hwpx.jar', import.meta.url)

/** OLE compound document signature — the first eight bytes of every HWP 5.0 file. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export function looksLikeHwp(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_SIGNATURE.length) return false
  return OLE_SIGNATURE.every((byte, i) => bytes[i] === byte)
}

export interface JavaRun {
  code: number | null
  /** True when the process was killed for exceeding the timeout. */
  timedOut: boolean
  stderr: string
}

/** How the converter is invoked; replaced in tests. */
export interface RunJava {
  (args: string[], options: { timeoutMs: number }): Promise<JavaRun>
}

export interface ConvertOptions {
  /** Path (or file URL) of the converter JAR. Defaults to the vendored one. */
  jar?: string | URL
  /** `java` executable; a deployment may point this at a specific JVM. */
  javaBin?: string
  timeoutMs?: number
  runJava?: RunJava
}

export type ConvertResult =
  | { ok: true; bytes: Uint8Array }
  | {
      ok: false
      reason: 'unsupported' | 'invalid' | 'timeout' | 'failed'
      error: string
    }

/** Spawn the JVM and wait for it. */
export function spawnJava(javaBin: string): RunJava {
  return (args, { timeoutMs }) =>
    new Promise<JavaRun>((resolve, reject) => {
      const child = spawn(javaBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout.on('data', () => {})
      child.stderr.on('data', (chunk: Buffer) => {
        // Bounded: a converter looping on a corrupt file could otherwise print
        // until this process runs out of memory.
        if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, timedOut, stderr })
      })
    })
}

const pathOf = (jar: string | URL): string =>
  typeof jar === 'string' ? jar : decodeURIComponent(new URL(jar).pathname)

/** Convert one document. */
export async function convertHwpToHwpx(
  bytes: Uint8Array,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  if (!looksLikeHwp(bytes)) {
    return {
      ok: false,
      reason: 'invalid',
      error: 'not an HWP 5.0 document (missing the compound-document signature)',
    }
  }

  const jar = pathOf(options.jar ?? VENDORED_JAR)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runJava = options.runJava ?? spawnJava(options.javaBin ?? 'java')

  const dir = await mkdtemp(join(tmpdir(), 'samugen-hwp-'))
  const input = join(dir, 'in.hwp')
  const output = join(dir, 'out.hwpx')
  try {
    await writeFile(input, bytes)
    let run: JavaRun
    try {
      run = await runJava(['-jar', jar, input, output], { timeoutMs })
    } catch (error) {
      // ENOENT here means no `java` on the PATH, which is the deployment's
      // problem and not the document's — reported as its own reason so the UI
      // can say "conversion is unavailable" rather than "this file is broken".
      return {
        ok: false,
        reason: 'unsupported',
        error: `cannot run the HWP converter: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (run.timedOut) {
      return { ok: false, reason: 'timeout', error: `conversion exceeded ${timeoutMs}ms` }
    }
    if (run.code !== 0) {
      return {
        ok: false,
        reason: 'failed',
        error: run.stderr.trim() || `converter exited with code ${run.code}`,
      }
    }
    let converted: Buffer
    try {
      converted = await readFile(output)
    } catch {
      // Exit 0 with no output file: the JAR reports failure this way for some
      // inputs, so it is a refusal rather than a filesystem fault.
      return { ok: false, reason: 'failed', error: 'the converter produced no output file' }
    }
    return { ok: true, bytes: new Uint8Array(converted) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Can this process convert at all? */
export async function converterAvailable(options: ConvertOptions = {}): Promise<boolean> {
  const jar = pathOf(options.jar ?? VENDORED_JAR)
  const runJava = options.runJava ?? spawnJava(options.javaBin ?? 'java')
  try {
    const run = await runJava(['-jar', jar], { timeoutMs: 30_000 })
    return !run.timedOut && run.code !== null
  } catch {
    return false
  }
}
