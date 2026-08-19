/**
 * The page's handle on the engine: the same eleven commands, one Worker away.
 *
 * Method for method this is `XlsxSidecarClient` (src/engine-node/xlsx-sidecar-client.ts) — which is
 * the point, since the ports above must not be able to tell which host answered. The
 * bookkeeping is the desktop's too, and for the same reason: requests are correlated by id,
 * because a Worker's replies arrive out of order relative to nothing in particular and the
 * caller is owed its own answer.
 *
 * What is deliberately absent is the desktop's timeout. There it guards against a child
 * process that died or wedged; here a wedged engine is a wedged Worker, and a timer would
 * free the caller while the Worker went on holding a half-saved workbook. A caller that
 * wants to give up can stop waiting; the engine is not something to abandon mid-write.
 */
import type { EngineMethod, EngineReply, MessageLink } from './protocol'

/** The engine-side path of a workbook, opaque above this layer. */
export type EnginePath = string

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export class XlsxWorkerClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private ready: Promise<void> | null = null

  constructor(
    private readonly link: MessageLink,
    private readonly wasmUrl: string,
  ) {
    this.link.onmessage = (event: { data: unknown }) => {
      const reply = event.data as EngineReply
      if (reply === null || typeof reply !== 'object' || reply.kind !== 'reply') return
      const pending = this.pending.get(reply.id)
      if (pending === undefined) return
      this.pending.delete(reply.id)
      if (reply.ok) pending.resolve(reply.result)
      else pending.reject(new Error(reply.error ?? 'The spreadsheet engine rejected a request.'))
    }
  }

  /**
   * Compile and instantiate, once.
   *
   * Every call funnels through here, so a caller never has to remember to start the engine —
   * and the compile happens on the first workbook rather than on page load, since a session
   * that never opens a spreadsheet should not pay 4.5MB for one.
   */
  start(): Promise<void> {
    this.ready ??= this.send('init', [])
    return this.ready
  }

  /** Hand a workbook's bytes to the engine and get back the path it knows them by. */
  async writeWorkbook(name: string, bytes: Uint8Array): Promise<EnginePath> {
    return (await this.call('writeWorkbook', [name, toTransferable(bytes)])) as EnginePath
  }

  /** Put bytes under the engine's scratch space, for a command that will read them. */
  async writeScratch(name: string, bytes: Uint8Array): Promise<EnginePath> {
    return (await this.call('writeScratch', [name, toTransferable(bytes)])) as EnginePath
  }

  /** Create a directory in the engine's filesystem, parents included. */
  async mkdir(path: EnginePath): Promise<void> {
    await this.call('mkdir', [path])
  }

  /** The bytes of a file the engine wrote. */
  async readFile(path: EnginePath): Promise<Uint8Array> {
    return new Uint8Array((await this.call('readFile', [path])) as ArrayBuffer)
  }

  async exists(path: EnginePath): Promise<boolean> {
    return (await this.call('exists', [path])) as boolean
  }

  /** Drop a workbook's bytes once its session is closed. */
  async removeWorkbook(path: EnginePath): Promise<void> {
    await this.call('removeWorkbook', [path])
  }

  // ── the eleven, in the desktop client's shape ──

  open(path: EnginePath): Promise<unknown> {
    return this.call('open', [path])
  }

  readRange(input: {
    readonly sessionId: string
    readonly sheetId: string
    readonly range: {
      readonly startRow: number
      readonly endRow: number
      readonly startColumn: number
      readonly endColumn: number
    }
  }): Promise<unknown> {
    return this.call('readRange', [input])
  }

  readFormulaCells(input: {
    readonly sessionId: string
    readonly sheetId: string
  }): Promise<unknown> {
    return this.call('readFormulaCells', [input])
  }

  readMedia(input: { readonly sessionId: string; readonly visualId: string }): Promise<unknown> {
    return this.call('readMedia', [input])
  }

  async close(sessionId: string): Promise<void> {
    await this.call('close', [sessionId])
  }

  archiveManifest(path: EnginePath): Promise<unknown> {
    return this.call('archiveManifest', [path])
  }

  readEntries(input: {
    readonly path: EnginePath
    readonly entries: readonly string[]
    readonly outputDir: EnginePath
  }): Promise<unknown> {
    return this.call('readEntries', [input])
  }

  scanEntries(input: {
    readonly path: EnginePath
    readonly entries: readonly string[]
    readonly needle: string
  }): Promise<unknown> {
    return this.call('scanEntries', [input])
  }

  convertWorkbook(input: {
    readonly path: EnginePath
    readonly targetPath: EnginePath
  }): Promise<unknown> {
    return this.call('convertWorkbook', [input])
  }

  saveArchive(input: {
    readonly sourcePath: EnginePath
    readonly targetPath: EnginePath
    readonly replacements: readonly { name: string; contentPath: string }[]
    readonly removals: readonly string[]
    readonly additions: readonly { name: string; contentPath: string }[]
  }): Promise<unknown> {
    return this.call('saveArchive', [input])
  }

  recalcCells(input: {
    readonly path: EnginePath
    readonly edits: readonly {
      readonly sheet: string
      readonly row: number
      readonly column: number
      readonly input: string
    }[]
    readonly reads: readonly {
      readonly sheet: string
      readonly range: {
        readonly startRow: number
        readonly endRow: number
        readonly startColumn: number
        readonly endColumn: number
      }
    }[]
  }): Promise<unknown> {
    return this.call('recalcCells', [input])
  }

  /** Every command starts the engine first; `start` itself must not recurse into this. */
  private async call(method: EngineMethod, args: readonly unknown[]): Promise<unknown> {
    await this.start()
    return this.send(method, args)
  }

  private send(method: EngineMethod | 'init', args: readonly unknown[]): Promise<void> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      const transfer = args.filter((arg): arg is ArrayBuffer => arg instanceof ArrayBuffer)
      this.link.postMessage(
        method === 'init'
          ? { kind: 'init', id, wasmUrl: this.wasmUrl }
          : { kind: 'request', id, method, args },
        transfer,
      )
    })
  }
}

/**
 * A view's bytes as a transferable buffer.
 *
 * Copied when the view is a window onto a larger buffer, because transferring that buffer
 * would take the rest of it with it — and the rest may be someone else's workbook.
 */
function toTransferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer)
}
