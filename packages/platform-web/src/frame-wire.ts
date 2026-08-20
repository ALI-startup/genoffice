/** The `postMessage` contract between the web shell and the editor frames it hosts. */

/** Protocol tag carried by every message, versioned in the string. */
export const FRAME_PROTOCOL = 'samugen.shell.frame.v1'

/** Query parameter naming the frame, set by the shell on the iframe URL. */
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
      /** Sent once, when the frame's protocol client is installed. */
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

/** The parts of a `MessageEvent` the validators read. */
export interface FrameMessageLike {
  origin: string
  data: unknown
}

/** Is this message from our own origin? */
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
