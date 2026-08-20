/** Handing bytes to the user as a download. */

/** The browser surfaces a download needs, injected so the logic above is testable. */
export interface DownloadEnv {
  /** `URL.createObjectURL`. */
  createObjectUrl(blob: Blob): string
  /** `URL.revokeObjectURL`. */
  revokeObjectUrl(url: string): void
  /** Start the download of `url` under `fileName`. */
  startDownload(url: string, fileName: string): void
  /** Run `task` after the current task has finished. */
  defer(task: () => void): void
}

/** How long to keep a finished download's object URL alive. */
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
      // The attribute is what makes this a download rather than a navigation, and its value is the
      // suggested file name.
      anchor.download = fileName
      anchor.rel = 'noopener'
      // Appended rather than clicked detached: Chromium honours a detached anchor, other engines
      // have not always, and a node added and removed in one task is invisible to the page.
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

/** Deliver `bytes` to the user as a file named `fileName`. */
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
