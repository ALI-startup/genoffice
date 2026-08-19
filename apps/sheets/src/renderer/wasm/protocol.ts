/**
 * The messages between the page and the engine's Worker.
 *
 * The engine is synchronous: `xlsx_handle` computes a whole answer before it returns, and a
 * large workbook's index or save is measured in seconds. That is fine on the desktop, where
 * it happens in another process, and unacceptable on the main thread of a page — hence a
 * Worker, and hence this.
 *
 * The shape is deliberately dull: one request, one reply, correlated by id. Method names are
 * `XlsxEngine`'s, so the client below and the engine inside the Worker share a vocabulary and
 * neither has a switch statement full of special cases.
 */

/** Everything the client may ask the Worker to do. */
export type EngineMethod =
  | 'open'
  | 'readRange'
  | 'readFormulaCells'
  | 'readMedia'
  | 'close'
  | 'archiveManifest'
  | 'readEntries'
  | 'scanEntries'
  | 'convertWorkbook'
  | 'saveArchive'
  | 'recalcCells'
  // File transfer, which has no equivalent on the desktop: there the workbook is already on
  // disk where the sidecar can reach it, and here the page has to put it there.
  | 'writeWorkbook'
  | 'writeScratch'
  | 'mkdir'
  | 'readFile'
  | 'exists'
  | 'removeWorkbook'

export interface EngineRequest {
  readonly kind: 'request'
  readonly id: number
  readonly method: EngineMethod
  readonly args: readonly unknown[]
}

export interface EngineReply {
  readonly kind: 'reply'
  readonly id: number
  readonly ok: boolean
  readonly result?: unknown
  /** Message only: an Error does not survive `postMessage` in every engine. */
  readonly error?: string
}

/** Sent once, before any request, so the Worker can compile the module. */
export interface EngineInit {
  readonly kind: 'init'
  readonly id: number
  /** Where to fetch the .wasm from. A URL rather than bytes: the browser caches it. */
  readonly wasmUrl: string
}

export type EngineOutbound = EngineInit | EngineRequest
export type EngineInbound = EngineReply

/** The half of a `MessagePort` either side needs. Injected, so tests need no Worker. */
export interface MessageLink {
  postMessage(message: unknown, transfer?: Transferable[]): void
  set onmessage(handler: ((event: { data: unknown }) => void) | null)
}
