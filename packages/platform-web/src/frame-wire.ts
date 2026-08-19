/**
 * The `postMessage` contract between the web shell and the editor frames it
 * hosts.
 *
 * Types plus validators, and deliberately free of any Node reference: both sides
 * import this one module (through the package's `./frame` export), so the shell
 * and the frames cannot drift — the same reason the AI wire lives in one file.
 *
 * Why a protocol at all, when the frames are same-origin and the shell could
 * simply reach into `contentWindow`? Two answers, and they divide the work:
 *
 *   - The *title* is not here. It is a document-level property the shell reads
 *     straight off `iframe.contentDocument.title`, which works precisely because
 *     the frames are same-origin, and needs no cooperation from the app.
 *   - The *dirty state* and the *save-before-close* handshake are here, because
 *     neither is a document property. Both live behind an app's platform port
 *     (docs' `onCloseCheck` / `reportCloseCheck`, pdf's `onCloseSaveRequest` /
 *     `reportCloseSaveResult`), and reaching into another document's module
 *     graph to drive them would be a coupling no type system could police.
 *     `beforeunload` cannot stand in for them: it does not fire when an iframe
 *     element is removed, which is exactly what closing a tab does.
 *
 * Everything inbound is validated. A page may receive a `message` from any
 * window that can get a reference to it — an opener, an embedder, another frame
 * — so an unvalidated handler is an injection surface. `parseFrameToShell` and
 * `parseShellToFrame` are the only way either side reads a message: they check
 * the origin, then the shape, field by field, and return `null` for anything
 * else. Neither ever throws, so a hostile message is dropped rather than turned
 * into an error the app has to handle.
 */

/**
 * Protocol tag carried by every message, versioned in the string.
 *
 * A version bump is a new tag, so an old frame and a new shell simply fail to
 * recognise each other's messages instead of misreading them. It is also what
 * makes this a distinctive token to grep the Electron bundle for: it must never
 * appear there.
 */
export const FRAME_PROTOCOL = 'samugen.shell.frame.v1'

/**
 * Query parameter naming the frame, set by the shell on the iframe URL.
 *
 * It is how a frame knows it is hosted at all: without it, the app is running
 * standalone and installs no protocol client. Making it explicit rather than
 * inferring from `window.parent !== window` means an app embedded by something
 * else does not start answering a protocol that embedder never spoke.
 */
export const FRAME_ID_PARAM = 'shellFrame'

/** Shell → frame. */
export type ShellToFrameMessage =
  | {
      protocol: typeof FRAME_PROTOCOL
      /** "Would closing you lose work?" Answered with `close-check-result`. */
      kind: 'close-check'
      requestId: string
    }
  | {
      protocol: typeof FRAME_PROTOCOL
      /** "Save now, then tell me how it went." Answered with `close-save-result`. */
      kind: 'close-save'
      requestId: string
    }

/** Frame → shell. */
export type FrameToShellMessage =
  | {
      protocol: typeof FRAME_PROTOCOL
      /**
       * Sent once, when the frame's protocol client is installed.
       *
       * The shell needs it to tell "this frame is loaded and simply has not
       * answered yet" from "this frame speaks no protocol". A close check that
       * times out on a frame that never announced itself is treated as clean —
       * a page that never loaded has no unsaved work — while one that times out
       * after `ready` is treated as dirty, because there the silence means the
       * app is wedged and an extra prompt is cheaper than a discarded document.
       */
      kind: 'ready'
      frameId: string
    }
  | {
      protocol: typeof FRAME_PROTOCOL
      kind: 'close-check-result'
      frameId: string
      requestId: string
      dirty: boolean
    }
  | {
      protocol: typeof FRAME_PROTOCOL
      kind: 'close-save-result'
      frameId: string
      requestId: string
      ok: boolean
    }

/**
 * The parts of a `MessageEvent` the validators read.
 *
 * Structural rather than the DOM type so the validators are exercisable without
 * a browser, and so the shell can pass the extra `source` check it performs on
 * top (see `createShellFrameLink`).
 */
export interface FrameMessageLike {
  origin: string
  data: unknown
}

/**
 * Is this message from our own origin?
 *
 * `expectedOrigin` is the page's own `location.origin`. The literal string
 * `'null'` is rejected explicitly: a sandboxed or `data:`-URL document posts
 * that opaque origin, and it must never match — including the case where the
 * page itself is opaque, where `expectedOrigin` would be `'null'` too and a
 * plain equality test would let every opaque document through.
 */
function originAllowed(origin: string, expectedOrigin: string): boolean {
  return origin !== 'null' && origin === expectedOrigin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tagged(data: unknown): data is Record<string, unknown> {
  return isRecord(data) && data.protocol === FRAME_PROTOCOL
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validate a message the shell received from a frame. `null` if it is not one. */
export function parseFrameToShell(
  event: FrameMessageLike,
  expectedOrigin: string,
): FrameToShellMessage | null {
  if (!originAllowed(event.origin, expectedOrigin)) return null
  const data = event.data
  if (!tagged(data)) return null
  if (!isNonEmptyString(data.frameId)) return null
  switch (data.kind) {
    case 'ready':
      return { protocol: FRAME_PROTOCOL, kind: 'ready', frameId: data.frameId }
    case 'close-check-result':
      if (!isNonEmptyString(data.requestId) || typeof data.dirty !== 'boolean') return null
      return {
        protocol: FRAME_PROTOCOL,
        kind: 'close-check-result',
        frameId: data.frameId,
        requestId: data.requestId,
        dirty: data.dirty,
      }
    case 'close-save-result':
      if (!isNonEmptyString(data.requestId) || typeof data.ok !== 'boolean') return null
      return {
        protocol: FRAME_PROTOCOL,
        kind: 'close-save-result',
        frameId: data.frameId,
        requestId: data.requestId,
        ok: data.ok,
      }
    default:
      return null
  }
}

/** Validate a message a frame received from the shell. `null` if it is not one. */
export function parseShellToFrame(
  event: FrameMessageLike,
  expectedOrigin: string,
): ShellToFrameMessage | null {
  if (!originAllowed(event.origin, expectedOrigin)) return null
  const data = event.data
  if (!tagged(data)) return null
  if (!isNonEmptyString(data.requestId)) return null
  switch (data.kind) {
    case 'close-check':
      return { protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: data.requestId }
    case 'close-save':
      return { protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: data.requestId }
    default:
      return null
  }
}
