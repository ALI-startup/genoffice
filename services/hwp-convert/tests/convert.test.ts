/**
 * The converter driver, without a JVM.
 *
 * `runJava` is injected precisely so this suite can walk the whole decision
 * tree — signature rejected, JVM missing, non-zero exit, exit 0 with no output,
 * timeout — every one of which is a distinct answer the browser renders
 * differently. Driving those through a real JVM would mean either a corrupt
 * fixture per case or no coverage of them at all.
 *
 * The real converter is exercised in `integration.test.ts`.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  convertHwpToHwpx,
  converterAvailable,
  looksLikeHwp,
  type JavaRun,
  type RunJava,
} from '../src/convert'

/** The eight bytes every HWP 5.0 file opens with, plus filler. */
const hwpBytes = (): Uint8Array =>
  new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])

const ok = (): JavaRun => ({ code: 0, timedOut: false, stderr: '' })

/** Records the argv it was handed, and writes `bytes` to the output path. */
function fakeJava(
  result: JavaRun | (() => Promise<JavaRun>),
  bytes?: Uint8Array,
): { run: RunJava; calls: string[][] } {
  const calls: string[][] = []
  const run: RunJava = async (args) => {
    calls.push(args)
    if (bytes) await writeFile(args[3], bytes)
    return typeof result === 'function' ? result() : result
  }
  return { run, calls }
}

describe('looksLikeHwp', () => {
  it('accepts the compound-document signature', () => {
    expect(looksLikeHwp(hwpBytes())).toBe(true)
  })

  it('rejects a zip, which is what a .hwpx or .docx renamed to .hwp would be', () => {
    expect(looksLikeHwp(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBe(false)
  })

  it('rejects bytes too short to hold a signature', () => {
    expect(looksLikeHwp(new Uint8Array([0xd0, 0xcf]))).toBe(false)
  })
})

describe('convertHwpToHwpx', () => {
  it('hands the JAR two paths and returns what it wrote', async () => {
    const converted = new Uint8Array([0x50, 0x4b, 1, 2, 3])
    const { run, calls } = fakeJava(ok(), converted)
    const result = await convertHwpToHwpx(hwpBytes(), { jar: '/opt/x.jar', runJava: run })

    expect(result).toEqual({ ok: true, bytes: converted })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('-jar')
    expect(calls[0][1]).toBe('/opt/x.jar')
    expect(calls[0][2]).toMatch(/\.hwp$/)
    expect(calls[0][3]).toMatch(/\.hwpx$/)
  })

  it('never starts a JVM for bytes that are not an HWP', async () => {
    const { run, calls } = fakeJava(ok(), new Uint8Array([1]))
    const result = await convertHwpToHwpx(new Uint8Array([0x50, 0x4b, 3, 4]), { runJava: run })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  it('reports a missing JVM as a deployment problem, not a bad file', async () => {
    const run: RunJava = () => Promise.reject(new Error('spawn java ENOENT'))
    const result = await convertHwpToHwpx(hwpBytes(), { runJava: run })

    expect(result).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(result.ok ? '' : result.error).toContain('ENOENT')
  })

  it('surfaces the converter stderr on a non-zero exit', async () => {
    const { run } = fakeJava({
      code: 2,
      timedOut: false,
      stderr: 'Conversion failed: bad record\n',
    })
    const result = await convertHwpToHwpx(hwpBytes(), { runJava: run })

    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(result.ok ? '' : result.error).toBe('Conversion failed: bad record')
  })

  it('falls back to the exit code when the converter said nothing', async () => {
    const { run } = fakeJava({ code: 3, timedOut: false, stderr: '   ' })
    const result = await convertHwpToHwpx(hwpBytes(), { runJava: run })

    expect(result.ok ? '' : result.error).toBe('converter exited with code 3')
  })

  it('treats exit 0 with no output file as a refusal', async () => {
    // Deliberately no `bytes`, so nothing is written where the JAR was told to.
    const { run } = fakeJava(ok())
    const result = await convertHwpToHwpx(hwpBytes(), { runJava: run })

    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(result.ok ? '' : result.error).toContain('no output file')
  })

  it('reports a timeout as its own reason, with the limit', async () => {
    const { run } = fakeJava({ code: null, timedOut: true, stderr: '' })
    const result = await convertHwpToHwpx(hwpBytes(), { runJava: run, timeoutMs: 1500 })

    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(result.ok ? '' : result.error).toContain('1500')
  })

  it('leaves no temp directory behind, on success or failure', async () => {
    const seen: string[] = []
    const run: RunJava = async (args) => {
      seen.push(args[2])
      await writeFile(args[3], new Uint8Array([1]))
      return ok()
    }
    await convertHwpToHwpx(hwpBytes(), { runJava: run })
    await convertHwpToHwpx(hwpBytes(), { runJava: () => Promise.reject(new Error('boom')) })

    expect(seen).toHaveLength(1)
    await expect(readFile(seen[0])).rejects.toThrow()
  })

  it('gives each conversion its own directory, so concurrent requests cannot collide', async () => {
    const dirs: string[] = []
    const run: RunJava = async (args) => {
      dirs.push(args[2])
      await writeFile(args[3], new Uint8Array([1]))
      return ok()
    }
    await Promise.all([
      convertHwpToHwpx(hwpBytes(), { runJava: run }),
      convertHwpToHwpx(hwpBytes(), { runJava: run }),
    ])

    expect(new Set(dirs).size).toBe(2)
  })

  it('accepts a jar given as a file URL as well as a path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samugen-jar-'))
    const jar = join(dir, 'converter.jar')
    const { run, calls } = fakeJava(ok(), new Uint8Array([1]))
    await convertHwpToHwpx(hwpBytes(), { jar: new URL(`file://${jar}`), runJava: run })

    expect(calls[0][1]).toBe(jar)
  })
})

describe('converterAvailable', () => {
  it('is true when the JAR runs at all — usage output included', async () => {
    // The JAR prints its usage and exits 1 with no arguments, which still proves
    // both the JVM and the JAR are there.
    const { run, calls } = fakeJava({ code: 1, timedOut: false, stderr: 'Usage: ...' })
    expect(await converterAvailable({ runJava: run })).toBe(true)
    expect(calls[0]).toHaveLength(2)
  })

  it('is false when there is no JVM to run it', async () => {
    expect(await converterAvailable({ runJava: () => Promise.reject(new Error('ENOENT')) })).toBe(
      false,
    )
  })

  it('is false when the probe hangs', async () => {
    const { run } = fakeJava({ code: null, timedOut: true, stderr: '' })
    expect(await converterAvailable({ runJava: run })).toBe(false)
  })
})
