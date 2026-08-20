/** Byte and text conversions, in the one form that works in both hosts. */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** UTF-8 bytes of `text`. The replacement for `Buffer.from(text, 'utf8')`. */
export function utf8Bytes(text: string): Uint8Array {
  return new Uint8Array(encoder.encode(text))
}

/** `bytes` decoded as UTF-8. The replacement for `Buffer.from(bytes).toString('utf8')`. */
export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Concatenate byte runs. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** Decode standard base64 to bytes. */
export function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Encode bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(binary)
}

/** Lowercase hex sha256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The view itself, not a copy of its bytes: `digest` hashes exactly the range the view covers, so
  // a JSZip view onto a larger pooled buffer is already safe.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** A GUID for a new part or section. */
export function randomGuid(): string {
  const webCrypto = globalThis.crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  const bytes = new Uint8Array(16)
  webCrypto.getRandomValues(bytes)
  // Version 4, variant 1, per RFC 4122 — the same shape randomUUID returns.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
