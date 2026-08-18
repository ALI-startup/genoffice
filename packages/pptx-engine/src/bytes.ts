/**
 * Byte and text conversions, in the one form that works in both hosts.
 *
 * This package is where the pptx model lives, and until now it assumed Node:
 * `Buffer.from(xml, 'utf8')` at every point where an XML part is written back
 * into the archive, `Buffer.from(b64, 'base64')` on the clipboard path, and
 * `createHash('sha256')` when an archive is opened. None of those exist in a
 * browser, and `Buffer` in particular fails at *runtime* rather than at build
 * time — a bundle referencing a global that is not there looks fine until a user
 * opens a deck.
 *
 * So the conversions live here, expressed with `TextEncoder` / `TextDecoder` /
 * `crypto.subtle`, which Node 20 and every target browser both provide as
 * globals. Nothing in this module is a polyfill or a fallback: there is one
 * implementation and both hosts run it, which is the only arrangement in which
 * the two cannot drift.
 *
 * `Uint8Array` is the currency, not `Buffer`. `PackageArchive.entries` was always
 * typed `Map<string, Uint8Array>` — `Buffer` merely satisfied it by being a
 * subclass — so this is the type the package already described.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * UTF-8 bytes of `text`. The replacement for `Buffer.from(text, 'utf8')`.
 *
 * The copy is load-bearing, however redundant it looks. `TextEncoder` may have been
 * created in a different JavaScript realm from the one this module runs in — which
 * is exactly the case under jsdom, where the test environment supplies Node's
 * `TextEncoder` but the page has its own `Uint8Array` — and the array it returns
 * then fails `instanceof Uint8Array` for every consumer. JSZip detects part bodies
 * with precisely that check and rejects anything it cannot name, so a save died
 * with "Can't read the data of '[Content_Types].xml'". Constructing here allocates
 * in *this* realm, which is the realm whose `Uint8Array` a caller will test against.
 */
export function utf8Bytes(text: string): Uint8Array {
  return new Uint8Array(encoder.encode(text))
}

/** `bytes` decoded as UTF-8. The replacement for `Buffer.from(bytes).toString('utf8')`. */
export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/**
 * Concatenate byte runs.
 *
 * `Buffer.concat`'s replacement, and the reason it is a function rather than a
 * spread into `Uint8Array.of`: the parts are whole file bodies, so copying
 * through an intermediate array of numbers would be an order of magnitude more
 * allocation than one sized buffer and a `set` per part.
 */
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

/**
 * Decode standard base64 to bytes.
 *
 * `atob` is a global in Node 16+ as well as every browser, and it is the only
 * base64 primitive both hosts share. It yields a string of code units 0–255, so
 * the copy into a `Uint8Array` is the decode.
 */
export function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Encode bytes as standard base64.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte as an
 * argument, and a slide's media part will exceed the engine's argument limit and
 * throw. 32 KiB is comfortably under it in every runtime.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(binary)
}

/**
 * Lowercase hex sha256 of `bytes`.
 *
 * Async, unlike the `createHash` it replaces, because `crypto.subtle` is the only
 * digest a browser has and it is promise-based. Its one caller — `PackageArchive.open`
 * — was already async, so the change stops there.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    // A copy, and deliberately so: `bytes` may be a view onto a larger buffer
    // (JSZip hands those out), and `digest` reads the whole backing buffer.
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * A GUID for a new part or section.
 *
 * `crypto.randomUUID()` is a global in Node 19+ and in browsers on a secure
 * origin — which the apps always are (`https`, or `localhost` in dev). The
 * fallback is not cosmetic: a page served over plain http on a LAN address has no
 * `randomUUID`, and a section id that came back `undefined` would be written into
 * the deck.
 */
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
