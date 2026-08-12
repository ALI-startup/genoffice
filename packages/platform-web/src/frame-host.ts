/**
 * The shell half of the frame protocol.
 *
 * Owns the set of live editor frames, asks them the two questions the close
 * guard needs, and reads their titles. It is the counterpart of Electron's
 * `TabManager`, minus everything a `WebContentsView` gives that an iframe does
 * not: there is no equivalent of `webContents.close()` here because removing the
 * element *is* the close, and no `setBounds` because CSS positions the frames.
 *
 * Two properties are worth stating outright, because they are what makes this
 * safe rather than merely working:
 *
 *   - **Every inbound message is validated twice.** `parseFrameToShell` checks
 *     the origin and the shape; this module then checks that the message's
 *     `source` is the very window it registered under that frame id. So a
 *     message from another same-origin document — another frame, an opener, a
 *     popup — cannot answer a close check on a tab's behalf and talk the shell
 *     into discarding that tab's unsaved work.
 *   - **Every request has a deadline.** A frame that is wedged, or that never
 *     installed a protocol client, must not hang the close. What the deadline
 *     resolves to depends on whether the frame ever announced itself: a frame
 *     that sent `ready` and then went quiet is treated as *dirty* (prompt, and
 *     let the user decide), while one that never did is treated as *clean*,
 *     because a page that never got as far as running its client has no unsaved
 *     work to lose.
 *
 * The title is deliberately not part of the protocol: the frames are
 * same-origin, so `contentDocument.title` is readable directly and no app has to
 * cooperate. `titleOf` is that read, guarded — a frame can be mid-navigation, in
 * which case there is simply no title yet.
 */
import { FRAME_PROTOCOL, parseFrameToShell } from './frame-wire.js'
import type { ShellToFrameMessage } from './frame-wire.js'

/** How long the shell waits for a frame to answer before deciding without it. */
export const FRAME_REPLY_TIMEOUT_MS = 2_000

/**
 * One hosted frame, as the shell holds it.
 *
 * Structural rather than `HTMLIFrameElement` so the link is exercisable without
 * a DOM, and so it is obvious that only three things are ever touched: posting
 * to the window, comparing it against a message's `source`, and reading the
 * document's title.
 */
export interface ShellFrameTarget {
  window: { postMessage(message: unknown, targetOrigin: string): void }
  /** `null` while the frame has no document yet (created, not yet navigated). */
  document: { title: string } | null
}

/** The window surface the link needs; injected so it is testable. */
export interface ShellFrameLinkEnv {
  /** The shell's own origin. Messages are checked and posted against it. */
  origin: string
  addEventListener: (type: 'message', handler: (event: MessageEvent) => void) => void
  removeEventListener: (type: 'message', handler: (event: MessageEvent) => void) => void
  setTimeout: (handler: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

export interface ShellFrameLink {
  /**
   * Attach or detach the frame behind a tab id.
   *
   * `null` detaches, which also fails any request in flight for that frame:
   * the element is going away, so nothing can answer.
   */
  register(frameId: string, target: ShellFrameTarget | null): void
  /** The frame's current document title, or `null` when it has none yet. */
  titleOf(frameId: string): string | null
  /** Has this frame announced itself? False for a frame that speaks no protocol. */
  isReady(frameId: string): boolean
  /** Ask the frame whether closing it would lose work. Never rejects. */
  wouldLoseWork(frameId: string): Promise<boolean>
  /** Ask the frame to save now. Resolves to whether it succeeded. Never rejects. */
  requestSave(frameId: string): Promise<boolean>
  dispose(): void
}

export function browserShellFrameLinkEnv(scope: Window = window): ShellFrameLinkEnv {
  return {
    origin: scope.location.origin,
    addEventListener: (type, handler) => scope.addEventListener(type, handler),
    removeEventListener: (type, handler) => scope.removeEventListener(type, handler),
    setTimeout: (handler, ms) => scope.setTimeout(handler, ms),
    clearTimeout: (handle) => scope.clearTimeout(handle),
  }
}

interface FrameRecord {
  target: ShellFrameTarget
  ready: boolean
}

interface Pending<T> {
  frameId: string
  settle(value: T): void
  timer: number
}

export function createShellFrameLink(
  env: ShellFrameLinkEnv = browserShellFrameLinkEnv(),
  timeoutMs: number = FRAME_REPLY_TIMEOUT_MS,
): ShellFrameLink {
  const frames = new Map<string, FrameRecord>()
  const closeChecks = new Map<string, Pending<boolean>>()
  const closeSaves = new Map<string, Pending<boolean>>()
  let nextRequest = 1

  const onMessage = (event: MessageEvent) => {
    const message = parseFrameToShell(event, env.origin)
    if (message === null) return
    const record = frames.get(message.frameId)
    // The second check: the message must come from the window registered under
    // that id. Origin alone is not identity — every frame of this app shares it.
    if (record === undefined || event.source !== record.target.window) return
    if (message.kind === 'ready') {
      record.ready = true
      return
    }
    const table = message.kind === 'close-check-result' ? closeChecks : closeSaves
    const pending = table.get(message.requestId)
    if (pending === undefined || pending.frameId !== message.frameId) return
    table.delete(message.requestId)
    env.clearTimeout(pending.timer)
    pending.settle(message.kind === 'close-check-result' ? message.dirty : message.ok)
  }

  env.addEventListener('message', onMessage)

  /** Post one request and wait for its answer, or for the deadline. */
  function ask(
    frameId: string,
    table: Map<string, Pending<boolean>>,
    kind: ShellToFrameMessage['kind'],
    onTimeout: (record: FrameRecord) => boolean,
  ): Promise<boolean> {
    const record = frames.get(frameId)
    if (record === undefined) return Promise.resolve(false)
    const requestId = `r${nextRequest++}`
    return new Promise<boolean>((resolve) => {
      const timer = env.setTimeout(() => {
        table.delete(requestId)
        resolve(onTimeout(record))
      }, timeoutMs)
      table.set(requestId, { frameId, settle: resolve, timer })
      const message: ShellToFrameMessage = { protocol: FRAME_PROTOCOL, kind, requestId }
      try {
        record.target.window.postMessage(message, env.origin)
      } catch {
        // A frame that cannot even be posted to is gone; do not wait for it.
        table.delete(requestId)
        env.clearTimeout(timer)
        resolve(onTimeout(record))
      }
    })
  }

  /** Fail everything outstanding for a frame that just went away. */
  function abandon(frameId: string): void {
    for (const [table, value] of [
      [closeChecks, false],
      [closeSaves, false],
    ] as const) {
      for (const [requestId, pending] of table) {
        if (pending.frameId !== frameId) continue
        table.delete(requestId)
        env.clearTimeout(pending.timer)
        pending.settle(value)
      }
    }
  }

  return {
    register(frameId: string, target: ShellFrameTarget | null): void {
      if (target === null) {
        frames.delete(frameId)
        abandon(frameId)
        return
      }
      const existing = frames.get(frameId)
      // Re-registering the same window is React handing back the same element on
      // a re-render; keep the readiness we already observed. A *different*
      // window is a new document, which has to announce itself again.
      if (existing !== undefined && existing.target.window === target.window) {
        existing.target = target
        return
      }
      frames.set(frameId, { target, ready: false })
    },

    titleOf(frameId: string): string | null {
      const record = frames.get(frameId)
      if (record === undefined) return null
      try {
        const title = record.target.document?.title
        return title !== undefined && title.length > 0 ? title : null
      } catch {
        // Reading a document mid-navigation can throw; no title is the honest answer.
        return null
      }
    },

    isReady(frameId: string): boolean {
      return frames.get(frameId)?.ready === true
    },

    wouldLoseWork(frameId: string): Promise<boolean> {
      // A frame that never announced itself has no protocol client, so silence
      // means "nothing running here", not "busy" — treat it as clean.
      return ask(frameId, closeChecks, 'close-check', (record) => record.ready)
    },

    requestSave(frameId: string): Promise<boolean> {
      return ask(frameId, closeSaves, 'close-save', () => false)
    },

    dispose(): void {
      env.removeEventListener('message', onMessage)
      for (const frameId of [...frames.keys()]) abandon(frameId)
      frames.clear()
    },
  }
}
