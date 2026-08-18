/**
 * Handing bytes to the user as a download.
 *
 * The one file-output path in this package that is *not* the File System Access
 * API, and it exists because FSA cannot answer every case. Writing through a
 * handle is strictly better when there is a handle: the user keeps editing the
 * file they opened, and a save is a save rather than a second copy. But a handle
 * only comes from a picker, a picker only opens for a user who asked, and a
 * document that has never been saved has no handle at all — a new document, or a
 * `.hwpx` converted on the way in. For those, a download is the only way out of
 * the page, and it is the way browsers already ask their users to think about
 * getting a file: it needs no permission grant, no second dialog, and it works
 * in a frame.
 *
 * Written against an injected `DownloadEnv` for the same reason the pickers are:
 * the mechanism (a Blob URL and an anchor click) is three lines of DOM that a
 * test cannot observe, so the DOM is the seam. `browserDownloadEnv` is the real
 * one and the only part of this file that touches a global.
 */

/** The browser surfaces a download needs, injected so the logic above is testable. */
export interface DownloadEnv {
  /** `URL.createObjectURL`. */
  createObjectUrl(blob: Blob): string
  /** `URL.revokeObjectURL`. */
  revokeObjectUrl(url: string): void
  /**
   * Start the download of `url` under `fileName`.
   *
   * The whole operation, not a piece of it: the real implementation creates an
   * `<a download>`, clicks it and removes it again. It is one member because the
   * anchor is an implementation detail — a host that had a better way to start a
   * download would replace this and nothing else.
   */
  startDownload(url: string, fileName: string): void
  /**
   * Run `task` after the current task has finished.
   *
   * Revoking an object URL is what frees the copy of the document held in memory,
   * and it must not happen synchronously after the click: the browser has only
   * been *told* to fetch the URL at that point, and revoking it in the same task
   * cancels the download in Chromium. Deferring is therefore load-bearing, and it
   * is injected so a test can run the revoke deterministically instead of waiting
   * on a timer.
   */
  defer(task: () => void): void
}

/**
 * How long to keep a finished download's object URL alive.
 *
 * Long enough that the browser has certainly started reading it, short enough
 * that a session of repeated downloads does not accumulate copies of the
 * document in memory.
 */
export const DOWNLOAD_URL_TTL_MS = 60_000

/** The real browser environment. The only globals this module reads. */
export function browserDownloadEnv(
  scope: {
    document: Document
    URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
    setTimeout: (task: () => void, ms: number) => unknown
  } = globalThis as unknown as {
    document: Document
    URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
    setTimeout: (task: () => void, ms: number) => unknown
  },
): DownloadEnv {
  return {
    createObjectUrl: (blob) => scope.URL.createObjectURL(blob),
    revokeObjectUrl: (url) => scope.URL.revokeObjectURL(url),
    startDownload: (url, fileName) => {
      const anchor = scope.document.createElement('a')
      anchor.href = url
      // The attribute is what makes this a download rather than a navigation, and
      // its value is the suggested file name. The browser sanitises it and may
      // still ask the user where to put it (that is their setting, not ours), so
      // the name is a suggestion in the same sense as a picker's.
      anchor.download = fileName
      anchor.rel = 'noopener'
      // Appended rather than clicked detached: Chromium honours a detached
      // anchor, other engines have not always, and a node added and removed in
      // one task is invisible to the page.
      anchor.style.display = 'none'
      scope.document.body.appendChild(anchor)
      try {
        anchor.click()
      } finally {
        anchor.remove()
      }
    },
    defer: (task) => void scope.setTimeout(task, DOWNLOAD_URL_TTL_MS),
  }
}

/**
 * Deliver `bytes` to the user as a file named `fileName`.
 *
 * Resolves once the browser has been handed the download. What happens next is
 * genuinely not observable to a page — the user may be shown a destination
 * prompt, may cancel it, may have downloads going to a folder automatically — so
 * this reports "handed over" and never claims the file is on disk. Callers that
 * need to know a file was written must use a `FileSystemFileHandle` instead.
 */
export function downloadBytes(
  env: DownloadEnv,
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string,
): void {
  const part = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
  const url = env.createObjectUrl(new Blob([part], { type: mimeType }))
  try {
    env.startDownload(url, fileName)
  } catch (error) {
    // A failed start would otherwise leak the blob for the life of the document.
    env.revokeObjectUrl(url)
    throw error
  }
  env.defer(() => env.revokeObjectUrl(url))
}
