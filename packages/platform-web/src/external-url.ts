/** Single validation gate for every URL the apps hand to the browser to open. */

export interface SafeExternalUrlOptions {
  /** Protocol allowlist (with trailing colon). Defaults to http/https only. */
  allowedProtocols?: readonly string[]
}

const DEFAULT_PROTOCOLS: readonly string[] = ['http:', 'https:']

/** Returns the URL string when it parses and its protocol is on the allowlist, otherwise null. */
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

/** Open a document's link in a new tab, or do nothing when it is not openable. */
export function openExternalUrl(url: unknown, options?: SafeExternalUrlOptions): void {
  const safe = safeExternalUrl(url, options)
  if (safe === null) return
  window.open(safe, '_blank', 'noopener,noreferrer')
}
