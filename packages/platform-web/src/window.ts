/**
 * The dirty-state and close-guard slice of `WindowPort`, for a browser host.
 *
 * This is the port where the browser and Electron genuinely differ, so it is
 * worth being precise about which members do work and which do not:
 *
 *   - `setDirty` does real work. It attaches and detaches a `beforeunload`
 *     listener, which is what makes the browser show its "Leave site?" prompt.
 *
 *   - `onCloseSaveRequest` is a real subscription that this host never emits an
 *     event for, and that is a legitimate implementation. The Electron flow is
 *     a handshake: the host intercepts the close, asks the renderer to save,
 *     *awaits* the answer, and only then closes. `beforeunload` cannot express
 *     that — the browser shows a generic, unstyled prompt, ignores any string
 *     the page supplies, and the page may not await anything before the
 *     document goes away. So there is no moment at which this host could
 *     honestly ask "save, then tell me how it went". An event source with no
 *     events is honest: it reports the truth (this host never makes that
 *     request) and every subscriber keeps working unchanged. What would *not*
 *     be honest is a method that pretends to do work — e.g. a `setDirty` that
 *     accepted the flag and dropped it, so the app believed unsaved work was
 *     protected when nothing was. That is the distinction this file draws.
 *
 *   - `reportCloseSaveResult` is the reply half of that handshake. With no
 *     requests there are no replies, so it is unreachable by construction: the
 *     only caller in the pdf renderer is inside the `onCloseSaveRequest`
 *     handler. It warns rather than silently returning, so that if the
 *     invariant is ever broken the mismatch is visible instead of swallowed.
 */
import type { WindowPort } from '@genoffice/platform'

export type WebWindowSlice = Pick<
  WindowPort,
  'setDirty' | 'onCloseSaveRequest' | 'reportCloseSaveResult'
>

/** The `window` members this port touches; injected so the adapter is testable. */
export interface CloseGuardEnv {
  addEventListener: (type: 'beforeunload', handler: (event: BeforeUnloadEvent) => void) => void
  removeEventListener: (type: 'beforeunload', handler: (event: BeforeUnloadEvent) => void) => void
}

/**
 * The other shape a browser close guard takes: ask at unload time instead of
 * being told in advance.
 *
 * `createWebWindowPort` below arms `beforeunload` from a push (`setDirty`). Some
 * apps have no such push — apps/docs never claimed `setDirty`, because its host
 * *pulls* the dirty state at close time — and for those the listener has to stay
 * installed and ask a predicate when the moment comes. That works because
 * `beforeunload` is synchronous and so is the question: "would work be lost?"
 * needs no I/O. What cannot be done either way is *saving* during unload, which
 * is why the save half of the handshake is still an event source with no events.
 *
 * @param shouldPrompt called during `beforeunload`; must be synchronous and must
 *   not block. `true` shows the browser's own "Leave site?" dialog.
 * @returns an unsubscribe.
 */
export function createWebUnloadPrompt(
  shouldPrompt: () => boolean,
  env: CloseGuardEnv = window,
): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    // A throwing predicate must not swallow the prompt: if we cannot tell
    // whether work would be lost, ask. An extra dialog is recoverable; a
    // discarded document is not.
    let prompt: boolean
    try {
      prompt = shouldPrompt()
    } catch {
      prompt = true
    }
    if (!prompt) return
    event.preventDefault()
    event.returnValue = ''
  }
  env.addEventListener('beforeunload', onBeforeUnload)
  return () => env.removeEventListener('beforeunload', onBeforeUnload)
}

export function createWebWindowPort(env: CloseGuardEnv = window): WebWindowSlice {
  let armed = false
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    // Both are required across Chromium versions to trigger the prompt; the
    // browser picks the wording itself and ignores whatever string we set.
    event.preventDefault()
    event.returnValue = ''
  }
  const closeSaveListeners = new Set<() => void>()

  return {
    setDirty(dirty: boolean): void {
      if (dirty === armed) return
      armed = dirty
      if (dirty) env.addEventListener('beforeunload', onBeforeUnload)
      else env.removeEventListener('beforeunload', onBeforeUnload)
    },
    onCloseSaveRequest(handler: () => void): () => void {
      closeSaveListeners.add(handler)
      return () => void closeSaveListeners.delete(handler)
    },
    reportCloseSaveResult(ok: boolean): void {
      console.warn(
        `[platform-web] close-save result (${ok}) reported, but this host never issues a ` +
          `close-save request. Something is calling the reply half of the handshake directly.`,
      )
    },
  }
}
