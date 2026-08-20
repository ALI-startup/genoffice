/** The page → Worker → engine path, end to end, without a Worker. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { XlsxWorkerClient } from '../src/renderer/wasm/client'
import { serveEngine } from '../src/renderer/wasm/worker-host'
import type { MessageLink } from '../src/renderer/wasm/protocol'
import { buildEditFixture } from './fixture-builder'

const WASM = join(import.meta.dirname, '../src/renderer/wasm/xlsx-sidecar.wasm')

/** Two ends of a channel, delivering asynchronously. */
function linkedPair(): { page: MessageLink; worker: MessageLink } {
  let onPage: ((event: { data: unknown }) => void) | null = null
  let onWorker: ((event: { data: unknown }) => void) | null = null
  const deliver = (
    handler: (() => ((event: { data: unknown }) => void) | null) | null,
    data: unknown,
  ) => {
    queueMicrotask(() => handler?.()?.({ data }))
  }
  return {
    page: {
      postMessage: (message: unknown) => deliver(() => onWorker, message),
      set onmessage(handler: ((event: { data: unknown }) => void) | null) {
        onPage = handler
      },
    },
    worker: {
      postMessage: (message: unknown) => deliver(() => onPage, message),
      set onmessage(handler: ((event: { data: unknown }) => void) | null) {
        onWorker = handler
      },
    },
  }
}

const built = existsSync(WASM)
const describeWorker = built ? describe : describe.skip
if (!built) {
  console.warn('[wasm-worker] skipped: run `npm run wasm:build -w @samugen/sheets` first')
}

describeWorker('the engine behind a worker link', () => {
  let wasm: ArrayBuffer
  let fixture: Uint8Array

  beforeAll(async () => {
    const bytes = await readFile(WASM)
    wasm = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    fixture = new Uint8Array(await buildEditFixture())
  })

  /** A client wired to a worker host that compiles the module already on disk. */
  function connect() {
    const { page, worker } = linkedPair()
    let counter = 0
    serveEngine(worker, {
      compile: () => WebAssembly.compile(wasm),
      newRequestId: () => `r${counter++}`,
      randomFill: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = (counter + index) % 251
        counter += 1
      },
    })
    return new XlsxWorkerClient(page, 'unused://module')
  }

  it('opens a workbook the page sent over the link and reads it back', async () => {
    const client = connect()
    const path = await client.writeWorkbook('book.xlsx', fixture)
    const opened = (await client.open(path)) as {
      sessionId: string
      name: string
      sheets: { id: string; rowCount: number; columnCount: number }[]
    }
    expect(opened.name).toBe('book.xlsx')

    const sheet = opened.sheets[0]!
    const range = (await client.readRange({
      sessionId: opened.sessionId,
      sheetId: sheet.id,
      range: {
        startRow: 0,
        endRow: sheet.rowCount - 1,
        startColumn: 0,
        endColumn: sheet.columnCount - 1,
      },
    })) as { cells: unknown[] }
    expect(range.cells.length).toBeGreaterThan(0)
  })

  it('starts the engine once, however many calls race for it', async () => {
    const client = connect()
    // Three commands issued before the first reply: each awaits `start`, and the module must
    // be compiled and instantiated exactly once regardless.
    const [first, second, third] = await Promise.all([
      client.writeWorkbook('a.xlsx', fixture),
      client.writeWorkbook('b.xlsx', fixture),
      client.writeWorkbook('c.xlsx', fixture),
    ])
    expect(new Set([first, second, third]).size).toBe(3)
    const opened = (await client.open(first)) as { sessionId: string }
    expect(opened.sessionId).toBeTruthy()
  })

  it('gives every caller its own answer when requests overlap', async () => {
    const client = connect()
    const path = await client.writeWorkbook('book.xlsx', fixture)
    const [manifest, scan, again] = await Promise.all([
      client.archiveManifest(path) as Promise<{ entries: { name: string }[] }>,
      client.scanEntries({ path, entries: ['xl/sharedStrings.xml'], needle: 'Hello' }) as Promise<{
        matches: string[]
      }>,
      client.archiveManifest(path) as Promise<{ entries: { name: string }[] }>,
    ])
    // Correlation, not order: the scan is answered from its own reply and the two identical
    // manifests do not swap places.
    expect(scan.matches).toEqual(['xl/sharedStrings.xml'])
    expect(manifest.entries.map((entry) => entry.name)).toEqual(
      again.entries.map((entry) => entry.name),
    )
  })

  it('carries an engine failure back to the caller that asked', async () => {
    const client = connect()
    const path = await client.writeWorkbook('book.xlsx', fixture)
    await expect(
      client.readRange({
        sessionId: 'not-a-session',
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
      }),
    ).rejects.toThrow(/session/i)
    await expect(client.archiveManifest(path)).resolves.toBeTruthy()
  })

  it('round-trips a saved archive across the link', async () => {
    const client = connect()
    const path = await client.writeWorkbook('book.xlsx', fixture)
    const target = await client.writeScratch('placeholder.xlsx', new Uint8Array(0))
    await client.saveArchive({
      sourcePath: path,
      targetPath: target,
      replacements: [],
      removals: [],
      additions: [],
    })
    const saved = await client.readFile(target)
    // The bytes are transferred out of the Worker, so this is the page's own copy of a zip.
    expect([...saved.slice(0, 2)]).toEqual([0x50, 0x4b])
    expect(saved.length).toBeGreaterThan(0)
  })

  it('forgets a workbook the page dropped', async () => {
    const client = connect()
    const path = await client.writeWorkbook('book.xlsx', fixture)
    expect(await client.exists(path)).toBe(true)
    await client.removeWorkbook(path)
    expect(await client.exists(path)).toBe(false)
  })
})
