/**
 * The Worker side: it owns the engine, and answers one message at a time.
 *
 * Written as a function over a `MessageLink` rather than as a script that reaches for
 * `self`, so the same code runs in a Worker, in a test, and — if it ever helps — on the main
 * thread. `worker.ts` is the four lines that hand it the real `self`.
 *
 * Requests are serialised deliberately. The engine is one wasm instance with one linear
 * memory and no threads; two overlapping calls would interleave inside it. A queue here is
 * both simpler and more honest than a lock inside the module.
 */
import { XlsxEngine, type EnginePath, type XlsxEngineOptions } from './engine'
import type { EngineOutbound, EngineReply, MessageLink } from './protocol'

export interface WorkerHostOptions extends XlsxEngineOptions {
  /** Fetch and compile the module. Injected so a test can hand over bytes it already has. */
  compile?: (wasmUrl: string) => Promise<WebAssembly.Module>
}

async function defaultCompile(wasmUrl: string): Promise<WebAssembly.Module> {
  const response = await fetch(wasmUrl)
  if (!response.ok) {
    throw new Error(`The spreadsheet engine could not be loaded (HTTP ${response.status}).`)
  }
  // Streaming compilation where the server sends the right type, and a plain compile where
  // it does not — some static hosts serve .wasm as octet-stream, and failing to open a
  // workbook over a Content-Type would be a poor trade.
  try {
    return await WebAssembly.compileStreaming(Promise.resolve(response.clone()))
  } catch {
    return WebAssembly.compile(await response.arrayBuffer())
  }
}

/** Start answering messages on `link`. Returns a function that stops listening. */
export function serveEngine(link: MessageLink, options: WorkerHostOptions = {}): () => void {
  const compile = options.compile ?? defaultCompile
  let engine: XlsxEngine | null = null
  /** Every message waits on this, so two requests can never be inside the module at once. */
  let queue: Promise<void> = Promise.resolve()

  const reply = (message: EngineReply): void => link.postMessage(message)

  const handle = async (message: EngineOutbound): Promise<unknown> => {
    if (message.kind === 'init') {
      engine = await XlsxEngine.start(await compile(message.wasmUrl), options)
      return null
    }
    if (engine === null) throw new Error('The spreadsheet engine has not been started.')
    const current = engine
    const args = message.args
    switch (message.method) {
      // ── file transfer ──
      case 'writeWorkbook':
        return current.writeWorkbook(args[0] as string, new Uint8Array(args[1] as ArrayBuffer))
      case 'writeScratch': {
        const path = current.scratchPath(args[0] as string)
        current.writeScratch(path, new Uint8Array(args[1] as ArrayBuffer))
        return path
      }
      case 'mkdir':
        current.makeDirectory(args[0] as EnginePath)
        return null
      case 'readFile': {
        // Copied out of the engine's memory and transferred, so the page owns the bytes and
        // the engine's filesystem is not aliased across threads.
        const bytes = current.readFile(args[0] as EnginePath)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
      case 'exists':
        return current.exists(args[0] as EnginePath)
      case 'removeWorkbook':
        current.removeWorkbook(args[0] as EnginePath)
        return null

      // ── the engine's own commands ──
      case 'open':
        return current.open(args[0] as EnginePath)
      case 'readRange':
        return current.readRange(args[0] as Parameters<XlsxEngine['readRange']>[0])
      case 'readFormulaCells':
        return current.readFormulaCells(args[0] as Parameters<XlsxEngine['readFormulaCells']>[0])
      case 'readMedia':
        return current.readMedia(args[0] as Parameters<XlsxEngine['readMedia']>[0])
      case 'close':
        return current.close(args[0] as string)
      case 'archiveManifest':
        return current.archiveManifest(args[0] as EnginePath)
      case 'readEntries':
        return current.readEntries(args[0] as Parameters<XlsxEngine['readEntries']>[0])
      case 'scanEntries':
        return current.scanEntries(args[0] as Parameters<XlsxEngine['scanEntries']>[0])
      case 'convertWorkbook':
        return current.convertWorkbook(args[0] as Parameters<XlsxEngine['convertWorkbook']>[0])
      case 'saveArchive':
        return current.saveArchive(args[0] as Parameters<XlsxEngine['saveArchive']>[0])
      case 'recalcCells':
        return current.recalcCells(args[0] as Parameters<XlsxEngine['recalcCells']>[0])
    }
  }

  link.onmessage = (event: { data: unknown }) => {
    const message = event.data as EngineOutbound
    if (message === null || typeof message !== 'object') return
    queue = queue.then(async () => {
      try {
        const result = await handle(message)
        // An ArrayBuffer result is transferred rather than copied: a workbook's bytes cross
        // this boundary on every save, and structured cloning them again is the one avoidable
        // megabyte-scale copy in the whole path.
        if (result instanceof ArrayBuffer) {
          link.postMessage({ kind: 'reply', id: message.id, ok: true, result }, [result])
          return
        }
        reply({ kind: 'reply', id: message.id, ok: true, result })
      } catch (error) {
        reply({
          kind: 'reply',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  return () => {
    link.onmessage = null
  }
}
