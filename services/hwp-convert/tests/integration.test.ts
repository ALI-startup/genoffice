/**
 * The real converter, on a real `.hwp`.
 *
 * `tests/fixtures/blank.hwp` is a genuine HWP 5.0 binary — an OLE compound
 * document, produced by hwplib's own `BlankFileMaker` with one line of Korean
 * and Latin text in it. It is the smallest thing that can prove the chain works
 * rather than merely that the driver's branches are wired up, which is what
 * `convert.test.ts` covers.
 *
 * Skipped where `java` is absent, and deliberately not mocked into passing: a
 * suite that reports success without having run the converter would be worse
 * than one that says it could not.
 */
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertHwpToHwpx, converterAvailable } from '../src/convert'

const FIXTURE = new URL('./fixtures/blank.hwp', import.meta.url)

/** `java -version` rather than the JAR: this decides whether to skip at all. */
const hasJava = spawnSync('java', ['-version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!hasJava)('the bundled converter', () => {
  it('reports itself available', async () => {
    expect(await converterAvailable()).toBe(true)
  })

  it('converts a real .hwp into a readable OWPML package', async () => {
    const result = await convertHwpToHwpx(new Uint8Array(await readFile(FIXTURE)))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // A package, not just bytes: mimetype and the two parts every reader needs.
    const zip = await JSZip.loadAsync(result.bytes)
    expect(await zip.file('mimetype')?.async('string')).toBe('application/hwp+zip')
    expect(zip.file('Contents/header.xml')).not.toBeNull()
    expect(zip.file('Contents/section0.xml')).not.toBeNull()
  })

  it('carries the text of the document through, Hangul included', async () => {
    const result = await convertHwpToHwpx(new Uint8Array(await readFile(FIXTURE)))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const zip = await JSZip.loadAsync(result.bytes)
    const section = await zip.file('Contents/section0.xml')!.async('string')
    // The exact string the fixture was built with — a converter that silently
    // produced an empty document would pass every structural check above.
    expect(section).toContain('한글 문서 테스트 Hello HWP')
  })

  it('refuses a file that is not an HWP at all', async () => {
    const result = await convertHwpToHwpx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })
})
