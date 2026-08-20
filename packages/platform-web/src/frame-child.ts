/** The frame half of the shell protocol. */
import { FRAME_ID_PARAM, FRAME_PROTOCOL, parseShellToFrame } from './frame-wire.js'
import type { FrameToShellMessage } from './frame-wire.js'

/** The window surface the link needs; injected so it is exercisable without a browser. */
export interface FrameChildEnv {
  /** This document's own origin; every message is checked and posted against it. */
  origin: string
  /** The frame id the shell assigned, or `null` when this page is not shell-hosted. */
  frameId: string | null
  /** The embedder to post answers to. `null` when there is no separate parent. */
  parent: { postMessage(message: unknown, targetOrigin: string): void } | null
  addEventListener: (type: 'message', handler: (event: MessageEvent) => void) => void
  removeEventListener: (type: 'message', handler: (event: MessageEvent) => void) => void
}

export interface FrameChildLink {
  /** The id the shell knows this frame by; echoed on every answer. */
  frameId: string
  /** Register the predicate that answers "would closing lose work?". */
  onCloseCheck(ask: () => boolean): void
  /** Register the handler that runs when the shell asks the frame to save. */
  onCloseSave(run: () => void): void
  /** Report the outcome of the save the shell asked for. Extra calls are ignored. */
  reportCloseSave(ok: boolean): void
  /** Stop listening. */
  dispose(): void
}

/** Read the shell-assigned frame id out of this page's URL. */
export function frameIdFromLocation(search: string): string | null {
  const id = new URLSearchParams(search).get(FRAME_ID_PARAM)
  return id !== null && id.length > 0 ? id : null
}

export function browserFrameChildEnv(scope: Window = window): FrameChildEnv {
  return {
    origin: scope.location.origin,
    frameId: frameIdFromLocation(scope.location.search),
    // `parent === self` at the top level, which is the "not embedded" case.
    parent: scope.parent !== scope ? scope.parent : null,
    addEventListener: (type, handler) => scope.addEventListener(type, handler),
    removeEventListener: (type, handler) => scope.removeEventListener(type, handler),
  }
}

/** Install the frame-side protocol client, or report that this page is not one. */
export function createFrameChildLink(
  env: FrameChildEnv = browserFrameChildEnv(),
): FrameChildLink | null {
  const { frameId, parent } = env
  if (frameId === null || parent === null) return null

  let askDirty: (() => boolean) | null = null
  let runSave: (() => void) | null = null
  /** The close-save request awaiting a reply; one at a time, by construction. */
  let pendingSave: string | null = null

  const post = (message: FrameToShellMessage) => parent.postMessage(message, env.origin)

  const onMessage = (event: MessageEvent) => {
    const message = parseShellToFrame(event, env.origin)
    if (message === null) return
    if (message.kind === 'close-check') {
      // A throwing or unregistered predicate reports dirty: an extra prompt is
      // recoverable, a discarded document is not. Same rule as the unload guard.
      let dirty = true
      if (askDirty !== null) {
        try {
          dirty = askDirty()
        } catch {
          dirty = true
        }
      }
      post({
        protocol: FRAME_PROTOCOL,
        kind: 'close-check-result',
        frameId,
        requestId: message.requestId,
        dirty,
      })
      return
    }
    // close-save
    if (runSave === null) {
      // Nothing to save with: answer immediately rather than let the shell wait
      // out its timeout, which it would then read as a failed save anyway.
      post({
        protocol: FRAME_PROTOCOL,
        kind: 'close-save-result',
        frameId,
        requestId: message.requestId,
        ok: false,
      })
      return
    }
    pendingSave = message.requestId
    try {
      runSave()
    } catch {
      const requestId = pendingSave
      pendingSave = null
      if (requestId !== null) {
        post({ protocol: FRAME_PROTOCOL, kind: 'close-save-result', frameId, requestId, ok: false })
      }
    }
  }

  env.addEventListener('message', onMessage)
  post({ protocol: FRAME_PROTOCOL, kind: 'ready', frameId })

  return {
    frameId,
    onCloseCheck(ask: () => boolean): void {
      askDirty = ask
    },
    onCloseSave(run: () => void): void {
      runSave = run
    },
    reportCloseSave(ok: boolean): void {
      const requestId = pendingSave
      // No request in flight: the app called the reply half on its own.
      if (requestId === null) return
      pendingSave = null
      post({ protocol: FRAME_PROTOCOL, kind: 'close-save-result', frameId, requestId, ok })
    },
    dispose(): void {
      env.removeEventListener('message', onMessage)
    },
  }
}
