/**
 * The xlsx engine, compiled to WebAssembly and answering the same protocol.
 *
 * The claim under test is the one Phase 6b rests on: that a browser can run the *same*
 * engine, not a second implementation of it. So this drives the wasm module through the real
 * protocol against a real workbook, and — when the desktop binary is also built — asserts the
 * two hosts return byte-identical JSON for the same requests.
 *
 * Node's own WASI stands in for the browser shim here. That is honest rather than a
 * shortcut: what is being tested is the module, and the module cannot tell which
 * implementation of `fd_read` answered it. The browser's shim is exercised by its own tests.
 *
 * Skipped, loudly, when `npm run wasm:build -w @genoffice/sheets` has not been run — the
 * module is 4.5MB of generated binary and is not committed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WASI } from 'node:wasi'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildEditFixture } from './fixture-builder'

const WASM = join(import.meta.dirname, '../src/renderer/wasm/xlsx-sidecar.wasm')
const NATIVE = join(import.meta.dirname, '../native/xlsx-engine/target/release/xlsx-sidecar')

interface Exports {
  memory: WebAssembly.Memory
  xlsx_alloc(len: number): number
  xlsx_handle(pointer: number, len: number): number
  xlsx_response_ptr(): number
}

/**
 * One instantiated module, plus the four lines of ABI that talk to it.
 *
 * Requests go in as UTF-8 in linear memory and responses come back the same way, which is
 * the whole interface — see native/xlsx-engine/src/wasm.rs.
 */
function startEngine(workDir: string, scratch: string) {
  return async () => {
    const wasi = new WASI({
      version: 'preview1',
      args: [],
      env: {},
      // The engine opens workbooks by path and extracts parts to a scratch directory, so a
      // host must give it both. In a page these are directories of a virtual filesystem.
      preopens: { '/work': workDir, '/tmp': scratch },
    })
    const module = await WebAssembly.compile(await readFile(WASM))
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject())
    wasi.initialize(instance)
    const api = instance.exports as unknown as Exports
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    return (request: Record<string, unknown>): Record<string, unknown> => {
      const payload = encoder.encode(JSON.stringify(request))
      const pointer = api.xlsx_alloc(payload.length)
      new Uint8Array(api.memory.buffer, pointer, payload.length).set(payload)
      const length = api.xlsx_handle(pointer, payload.length)
      const bytes = new Uint8Array(api.memory.buffer, api.xlsx_response_ptr(), length)
      return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>
    }
  }
}

/** The same requests through the desktop sidecar's stdin, for the differential check. */
function throughNative(requests: Record<string, unknown>[]): Record<string, unknown>[] {
  const stdout = execFileSync(NATIVE, {
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const built = existsSync(WASM)
const describeWasm = built ? describe : describe.skip
if (!built) {
  console.warn(`[wasm-engine] skipped: run \`npm run wasm:build -w @genoffice/sheets\` first`)
}

describeWasm('the xlsx engine in WebAssembly', () => {
  let call: (request: Record<string, unknown>) => Record<string, unknown>
  let workbookPath: string

  beforeAll(async () => {
    const work = mkdtempSync(join(tmpdir(), 'wasm-engine-work-'))
    const scratch = mkdtempSync(join(tmpdir(), 'wasm-engine-tmp-'))
    workbookPath = join(work, 'book.xlsx')
    writeFileSync(workbookPath, await buildEditFixture())
    call = await startEngine(work, scratch)()
  })

  it('opens a workbook and reads a range, with the sheet metadata a renderer needs', () => {
    const manifest = call({
      version: 1,
      requestId: 'm',
      command: 'archive_manifest',
      path: '/work/book.xlsx',
    })
    expect(manifest.ok, JSON.stringify(manifest.error)).toBe(true)

    const opened = call({ version: 1, requestId: 'o', command: 'open', path: '/work/book.xlsx' })
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const result = opened.result as {
      sessionId: string
      sheets: { id: string; name: string; rowCount: number; columnCount: number }[]
    }
    expect(result.sheets.length).toBeGreaterThan(0)

    // The used area, as the host just reported it: asking beyond it is a rejected request on
    // both hosts, and this test is about the answer inside it.
    const sheet = result.sheets[0]!
    const range = call({
      version: 1,
      requestId: 'r',
      command: 'read_range',
      sessionId: result.sessionId,
      sheetId: sheet.id,
      range: {
        startRow: 0,
        endRow: sheet.rowCount - 1,
        startColumn: 0,
        endColumn: sheet.columnCount - 1,
      },
    })
    expect(range.ok, JSON.stringify(range.error)).toBe(true)
    const cells = (range.result as { cells: unknown[] }).cells
    expect(cells.length).toBeGreaterThan(0)
    // Indexing runs inline on this host because wasm32-wasip1 has no threads; the reader
    // must therefore always find a finished index rather than a partial one.
    expect((range.result as { indexingComplete: boolean }).indexingComplete).toBe(true)
  })

  it('reports an unknown session the same way the desktop does, without trapping', () => {
    const answer = call({
      version: 1,
      requestId: 'x',
      command: 'read_range',
      sessionId: 'not-a-session',
      sheetId: 'sheet-1',
      range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
    })
    expect(answer).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    })
    // Still alive: an error must not cost the page its open workbook.
    const after = call({
      version: 1,
      requestId: 'y',
      command: 'archive_manifest',
      path: '/work/book.xlsx',
    })
    expect(after.ok).toBe(true)
  })

  it('answers exactly what the desktop sidecar answers', () => {
    if (!existsSync(NATIVE)) {
      console.warn('[wasm-engine] differential check skipped: cargo build --release first')
      return
    }
    // Paths differ between the hosts by necessity — one is a real file, the other a
    // preopened directory — so they are the one field excluded from the comparison. The
    // rest of the response is expected to match character for character.
    const wasmRequests = [
      { version: 1, requestId: 'a', command: 'archive_manifest', path: '/work/book.xlsx' },
      {
        version: 1,
        requestId: 'b',
        command: 'scan_entries',
        path: '/work/book.xlsx',
        entries: ['xl/worksheets/sheet1.xml'],
        needle: 'c r=',
      },
    ]
    const native = throughNative(
      wasmRequests.map((request) => ({ ...request, path: workbookPath })),
    )
    const wasm = wasmRequests.map((request) => call(request))
    expect(wasm).toEqual(native)
  })
})
