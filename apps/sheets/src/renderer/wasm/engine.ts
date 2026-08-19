/**
 * The xlsx engine in a page: the wasm module, its filesystem, and the eleven commands.
 *
 * The method list is `XlsxSidecarClient`'s (src/main/xlsx-sidecar-client.ts), because the
 * callers above it must not be able to tell which host answered. What differs is everything
 * below: no process, no pipe, no request ids to correlate — a call into linear memory returns
 * before the next one starts, so a `Map` of pending requests and a timeout would be
 * bookkeeping for an event that cannot happen.
 *
 * The other difference the callers *do* see is where a workbook lives. The desktop's paths
 * name files on the user's disk; here the host puts the bytes into this engine's filesystem
 * first (`writeWorkbook`) and takes results back out of it (`readFile`), and the paths in
 * between are its own. That is what `WORK_DIR` is for.
 */
import { WasiExit, WasiHost } from './wasi'

const PROTOCOL_VERSION = 1

/** Where the host writes workbooks. The engine only ever sees paths under here. */
export const WORK_DIR = '/work'
/** The engine's scratch space: a session extracts its parts here, as it does under /tmp. */
export const TEMP_DIR = '/tmp'

interface EngineExports {
  memory: WebAssembly.Memory
  xlsx_alloc(length: number): number
  xlsx_handle(pointer: number, length: number): number
  xlsx_response_ptr(): number
}

interface SidecarResponse {
  readonly version: number
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

export interface XlsxEngineOptions {
  /** Injected for tests; production reads `crypto.randomUUID`. */
  newRequestId?: () => string
  /** Injected for tests; production uses `Date.now`. */
  now?: () => number
  /** Injected for tests; production uses `crypto.getRandomValues`. */
  randomFill?: (bytes: Uint8Array) => void
}

/**
 * A workbook the page has handed over, addressed the way the engine expects.
 *
 * Not a path the caller invents: `writeWorkbook` returns it, and it is the only thing the
 * caller may pass back as `path`. Same reasoning as the document refs elsewhere in the
 * migration — the host owns the naming, and nothing above parses one.
 */
export type EnginePath = string

export class XlsxEngine {
  private readonly host: WasiHost
  private readonly exports: EngineExports
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private readonly newRequestId: () => string
  private nextWorkbook = 0

  private constructor(instance: WebAssembly.Instance, host: WasiHost, options: XlsxEngineOptions) {
    this.host = host
    this.exports = instance.exports as unknown as EngineExports
    this.newRequestId = options.newRequestId ?? (() => crypto.randomUUID())
  }

  /**
   * Instantiate the module and hand back an engine ready for its first command.
   *
   * `module` is compiled by the caller so a Worker can compile once and instantiate per
   * workbook if it ever needs to — and so this function stays synchronous about everything
   * except the instantiation itself.
   */
  static async start(
    module: WebAssembly.Module,
    options: XlsxEngineOptions = {},
  ): Promise<XlsxEngine> {
    const host = new WasiHost({
      preopens: [WORK_DIR, TEMP_DIR],
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.randomFill === undefined ? {} : { randomFill: options.randomFill }),
    })
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: host.imports,
    })
    const exports = instance.exports as unknown as EngineExports & {
      _initialize?: () => void
    }
    host.bind(exports.memory)
    // A reactor module initialises on demand rather than running a `main`; std's setup
    // (allocator, environment) happens here.
    exports._initialize?.()
    return new XlsxEngine(instance, host, options)
  }

  /** Put a workbook's bytes where the engine can open them, and say where that is. */
  writeWorkbook(name: string, bytes: Uint8Array): EnginePath {
    // A directory per workbook, so two open at once cannot collide on a name and a `close`
    // can drop the whole thing. The name is kept because the engine reports it back as the
    // workbook's own (it feeds CELL("filename") and the title bar).
    const path = `${WORK_DIR}/w${this.nextWorkbook++}/${name}`
    this.host.fs.writeFile(path, bytes)
    return path
  }

  /**
   * Put bytes at a path the engine will be told to read.
   *
   * The save pipeline plans patched parts in memory and hands the engine their *paths* to
   * reassemble from, so those parts have to exist in the engine's filesystem first. On the
   * desktop they are files in a temp directory; here they are entries under /tmp.
   */
  writeScratch(path: EnginePath, bytes: Uint8Array): void {
    this.host.fs.writeFile(path, bytes)
  }

  /** The bytes of a file the engine wrote — a saved archive, a converted workbook. */
  readFile(path: EnginePath): Uint8Array {
    return this.host.fs.readFile(path)
  }

  /** Create a directory the engine will be asked to extract into. */
  makeDirectory(path: EnginePath): void {
    this.host.fs.mkdirp(path)
  }

  /** Drop a workbook's directory once its session is closed, freeing the bytes. */
  removeWorkbook(path: EnginePath): void {
    const directory = path.slice(0, path.lastIndexOf('/'))
    this.host.fs.removeAll(directory)
  }

  /** Whether the engine produced a file at all; a cancelled save writes nothing. */
  exists(path: EnginePath): boolean {
    return this.host.fs.exists(path)
  }

  /** A path under the engine's scratch space, for commands that write one. */
  scratchPath(name: string): EnginePath {
    return `${TEMP_DIR}/${name}`
  }

  // ── the eleven commands, in the sidecar client's shape ──

  open(path: EnginePath): Promise<unknown> {
    return this.request({ command: 'open', path })
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
    return this.request({ command: 'read_range', ...input })
  }

  readFormulaCells(input: {
    readonly sessionId: string
    readonly sheetId: string
  }): Promise<unknown> {
    return this.request({ command: 'read_formula_cells', ...input })
  }

  readMedia(input: { readonly sessionId: string; readonly visualId: string }): Promise<unknown> {
    return this.request({ command: 'read_media', ...input })
  }

  async close(sessionId: string): Promise<void> {
    await this.request({ command: 'close', sessionId })
  }

  archiveManifest(path: EnginePath): Promise<unknown> {
    return this.request({ command: 'archive_manifest', path })
  }

  readEntries(input: {
    readonly path: EnginePath
    readonly entries: readonly string[]
    readonly outputDir: EnginePath
  }): Promise<unknown> {
    return this.request({ command: 'read_entries', ...input })
  }

  scanEntries(input: {
    readonly path: EnginePath
    readonly entries: readonly string[]
    readonly needle: string
  }): Promise<unknown> {
    return this.request({ command: 'scan_entries', ...input })
  }

  convertWorkbook(input: {
    readonly path: EnginePath
    readonly targetPath: EnginePath
  }): Promise<unknown> {
    return this.request({ command: 'convert_workbook', ...input })
  }

  saveArchive(input: {
    readonly sourcePath: EnginePath
    readonly targetPath: EnginePath
    readonly replacements: readonly { name: string; contentPath: string }[]
    readonly removals: readonly string[]
    readonly additions: readonly { name: string; contentPath: string }[]
  }): Promise<unknown> {
    return this.request({ command: 'save_archive', ...input })
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
    return this.request({ command: 'recalc_cells', ...input })
  }

  /**
   * One request in, one response out.
   *
   * `async` to match the desktop client's signature, not because anything here awaits: the
   * module is synchronous, which is precisely why it belongs in a Worker.
   */
  private async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    const payload = this.encoder.encode(
      JSON.stringify({ version: PROTOCOL_VERSION, requestId: this.newRequestId(), ...command }),
    )
    const pointer = this.exports.xlsx_alloc(payload.length)
    // A fresh view per call: growing the module's memory detaches the old ArrayBuffer, and a
    // held view would silently write nowhere.
    new Uint8Array(this.exports.memory.buffer, pointer, payload.length).set(payload)
    let length: number
    try {
      length = this.exports.xlsx_handle(pointer, payload.length)
    } catch (error) {
      if (error instanceof WasiExit) {
        throw new Error(`The spreadsheet engine stopped unexpectedly (exit ${error.code}).`, {
          cause: error,
        })
      }
      throw error
    }
    const bytes = new Uint8Array(
      this.exports.memory.buffer,
      this.exports.xlsx_response_ptr(),
      length,
    )
    const response = JSON.parse(this.decoder.decode(bytes)) as SidecarResponse
    if (response.version !== PROTOCOL_VERSION) {
      throw new Error('The spreadsheet engine answered an unsupported protocol version.')
    }
    if (!response.ok) {
      throw new Error(response.error?.message ?? 'The spreadsheet engine rejected a request.')
    }
    return response.result
  }
}
