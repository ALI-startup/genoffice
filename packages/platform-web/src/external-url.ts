/**
 * Single validation gate for every URL the apps hand to the browser to open.
 *
 * The URLs are untrusted: they come out of documents (a pptx run link, a PDF link
 * annotation, a hyperlink in a cell) and out of AI output, and `window.open` will
 * happily take `javascript:` — which runs in the opener's origin — or a custom app
 * scheme. Anything that is not a well-formed URL on the protocol allowlist is
 * rejected here rather than at each call site.
 *
 * This gate came from the desktop, where it guarded `shell.openExternal` against the
 * OS handler. The browser is not a softer target for it: the page has the user's
 * documents in it, so a `javascript:` URL opened from a link in one of them would run
 * with access to the rest.
 */

export interface SafeExternalUrlOptions {
  /** Protocol allowlist (with trailing colon). Defaults to http/https only. */
  allowedProtocols?: readonly string[]
}

const DEFAULT_PROTOCOLS: readonly string[] = ['http:', 'https:']

/**
 * Returns the URL string when it parses and its protocol is on the allowlist,
 * otherwise null. Callers must not fall back to opening the raw input.
 */
export function safeExternalUrl(url: unknown, options?: SafeExternalUrlOptions): string | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const allowed = options?.allowedProtocols ?? DEFAULT_PROTOCOLS
  return allowed.includes(parsed.protocol) ? url : null
}

/**
 * Open a document's link in a new tab, or do nothing when it is not openable.
 *
 * `noopener,noreferrer` for the same reason the protocol is checked: the opened page
 * must not get a handle on this one, which holds the open document.
 */
export function openExternalUrl(url: unknown, options?: SafeExternalUrlOptions): void {
  const safe = safeExternalUrl(url, options)
  if (safe === null) return
  window.open(safe, '_blank', 'noopener,noreferrer')
}
