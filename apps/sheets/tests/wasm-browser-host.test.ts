/**
 * The engine on the host a browser actually gets: our own WASI shim, over an in-memory
 * filesystem.
 *
 * `wasm-engine.test.ts` proves the module is right by running it under Node's WASI. This one
 * proves the *shim* is right, by running the same module against the implementation that
 * ships — which is where a mistake would be silent, since an `fd_read` that returns the wrong
 * count corrupts a workbook rather than failing.
 *
 * Skipped, loudly, when `npm run wasm:build -w @samugen/sheets` has not been run.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { MemFs, readAt, writeAt } from '../src/renderer/wasm/memfs'
import { XlsxEngine } from '../src/renderer/wasm/engine'
import { buildEditFixture } from './fixture-builder'

const WASM = join(import.meta.dirname, '../src/renderer/wasm/xlsx-sidecar.wasm')

describe('the in-memory filesystem', () => {
  it('reads back what it wrote, at an offset and past the end', () => {
    const fs = new MemFs(() => 0)
    fs.writeFile('/work/a/book.xlsx', new Uint8Array([1, 2, 3]))
    expect([...fs.readFile('/work/a/book.xlsx')]).toEqual([1, 2, 3])

    const file = fs.createFile('/work/a/out.bin', true)
    writeAt(file, 0, new Uint8Array([9, 9]))
    writeAt(file, 4, new Uint8Array([7]))
    // The gap is zero-filled and the size follows the furthest write, as a real file does.
    expect([...fs.readFile('/work/a/out.bin')]).toEqual([9, 9, 0, 0, 7])
    expect([...readAt(file, 3, 10)]).toEqual([0, 7])
    expect([...readAt(file, 99, 10)]).toEqual([])
  })

  it('refuses to walk out of a directory', () => {
    const fs = new MemFs(() => 0)
    fs.writeFile('/work/book.xlsx', new Uint8Array([1]))
    // `..` is the one path component a page's filesystem must not honour: a preopen is the
    // whole sandbox, and escaping it is the failure mode that matters.
    expect(() => fs.readFile('/work/../work/book.xlsx')).toThrow(/INVAL/)
  })

  it('reports the failures the syscall layer maps onto errnos', () => {
    const fs = new MemFs(() => 0)
    fs.mkdirp('/work/dir')
    expect(() => fs.readFile('/work/missing')).toThrow(/NOENT/)
    expect(() => fs.readFile('/work/dir')).toThrow(/ISDIR/)
    expect(() => fs.mkdir('/work/dir')).toThrow(/EXIST/)
    fs.writeFile('/work/dir/file', new Uint8Array([1]))
    expect(() => fs.rmdir('/work/dir')).toThrow(/NOTEMPTY/)
  })
})

const built = existsSync(WASM)
const describeEngine = built ? describe : describe.skip
if (!built) {
  console.warn('[wasm-browser-host] skipped: run `npm run wasm:build -w @samugen/sheets` first')
}

describeEngine('the engine over the browser shim', () => {
  let module: WebAssembly.Module
  let fixture: Uint8Array

  beforeAll(async () => {
    module = await WebAssembly.compile(await readFile(WASM))
    fixture = new Uint8Array(await buildEditFixture())
  })

  /** A fresh engine with the fixture already in its filesystem. */
  async function withWorkbook() {
    let counter = 0
    const engine = await XlsxEngine.start(module, {
      newRequestId: () => `r${counter++}`,
      now: () => 1_700_000_000_000,
      // Deterministic but *distinct*: the engine's session ids are UUIDv4s drawn from
      // `random_get`, so a constant filler would make two sessions collide on the scratch
      // directory they create. A browser passes `crypto.getRandomValues` and never sees it.
      randomFill: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = (counter + index) % 251
        counter += 1
      },
    })
    const path = engine.writeWorkbook('book.xlsx', fixture)
    return { engine, path }
  }

  it('opens a workbook the page handed it, and reads cells back', async () => {
    const { engine, path } = await withWorkbook()
    const opened = (await engine.open(path)) as {
      sessionId: string
      name: string
      sheets: { id: string; name: string; rowCount: number; columnCount: number }[]
    }
    // The name the page supplied comes back as the workbook's own — it feeds the title bar
    // and CELL("filename"), and the engine has no other way to know it.
    expect(opened.name).toBe('book.xlsx')
    expect(opened.sheets.length).toBeGreaterThan(0)

    const sheet = opened.sheets[0]!
    const range = (await engine.readRange({
      sessionId: opened.sessionId,
      sheetId: sheet.id,
      range: {
        startRow: 0,
        endRow: sheet.rowCount - 1,
        startColumn: 0,
        endColumn: sheet.columnCount - 1,
      },
    })) as { cells: { row: number; column: number; value?: unknown }[] }
    expect(range.cells.length).toBeGreaterThan(0)

    await engine.close(opened.sessionId)
  })

  it('lists an archive and finds text inside a part', async () => {
    const { engine, path } = await withWorkbook()
    const manifest = (await engine.archiveManifest(path)) as { entries: { name: string }[] }
    const names = manifest.entries.map((entry) => entry.name)
    expect(names).toContain('xl/workbook.xml')

    // Text runs, not markup: the engine searches what a reader would see, so the needle has
    // to be cell text rather than an element name.
    const scan = (await engine.scanEntries({
      path,
      entries: ['xl/sharedStrings.xml', 'xl/workbook.xml'],
      needle: 'Hello',
    })) as { matches: string[] }
    expect(scan.matches).toEqual(['xl/sharedStrings.xml'])
  })

  it('saves an archive the page can read back out', async () => {
    const { engine, path } = await withWorkbook()
    // The save path is the one that writes through the shim rather than reading: a wrong
    // offset or count here produces a corrupt workbook rather than an error.
    const target = engine.scratchPath('saved.xlsx')
    await engine.saveArchive({
      sourcePath: path,
      targetPath: target,
      replacements: [],
      removals: [],
      additions: [],
    })
    const saved = engine.readFile(target)
    expect(saved.length).toBeGreaterThan(0)
    // A zip, and one the engine itself can open again.
    expect([...saved.slice(0, 2)]).toEqual([0x50, 0x4b])

    const reopened = engine.writeWorkbook('roundtrip.xlsx', saved)
    const opened = (await engine.open(reopened)) as { sheets: unknown[] }
    expect(opened.sheets.length).toBeGreaterThan(0)
  })

  it('surfaces an engine error as a rejected call, and stays usable', async () => {
    const { engine, path } = await withWorkbook()
    await expect(
      engine.readRange({
        sessionId: 'not-a-session',
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      }),
    ).rejects.toThrow(/session/i)
    // The page must not lose its engine to a bad request.
    await expect(engine.archiveManifest(path)).resolves.toBeTruthy()
  })

  it('keeps two workbooks apart', async () => {
    const { engine, path } = await withWorkbook()
    const second = engine.writeWorkbook('book.xlsx', fixture)
    // Same file name, different directories: the host names them, so one cannot shadow the
    // other however the page labels them.
    expect(second).not.toBe(path)
    const a = (await engine.open(path)) as { sessionId: string }
    const b = (await engine.open(second)) as { sessionId: string }
    expect(a.sessionId).not.toBe(b.sessionId)
  })
})
