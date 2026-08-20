/** The dirty-state and close-guard slice of `WindowPort`, for a browser host. */
import type { WindowPort } from '@samugen/platform'
import type { FrameChildLink } from './frame-child.js'

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
 * The other shape a browser close guard takes: ask at unload time instead of being told in advance.
 */
export function createWebUnloadPrompt(
  shouldPrompt: () => boolean,
  env: CloseGuardEnv = window,
): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    // A throwing predicate must not swallow the prompt: if we cannot tell whether work would be
    // lost, ask.
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

/**
 * @param frame the shell frame link when this page is hosted in the web shell's tab strip, `null`
 * when it is a standalone browser tab.
 */
export function createWebWindowPort(
  env: CloseGuardEnv = window,
  frame: FrameChildLink | null = null,
): WebWindowSlice {
  let armed = false
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    // Both are required across Chromium versions to trigger the prompt; the
    // browser picks the wording itself and ignores whatever string we set.
    event.preventDefault()
    event.returnValue = ''
  }
  const closeSaveListeners = new Set<() => void>()

  if (frame !== null) {
    // The shell's close check is answered from the same flag `beforeunload` is
    // armed from, so a tab close and a window close ask the identical question.
    frame.onCloseCheck(() => armed)
    frame.onCloseSave(() => {
      if (closeSaveListeners.size === 0) {
        // Nobody is listening, so nothing will ever reply.
        frame.reportCloseSave(false)
        return
      }
      for (const listener of closeSaveListeners) listener()
    })
  }

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
      if (frame !== null) {
        frame.reportCloseSave(ok)
        return
      }
      console.warn(
        `[platform-web] close-save result (${ok}) reported, but this host never issues a ` +
          `close-save request. Something is calling the reply half of the handshake directly.`,
      )
    },
  }
}
