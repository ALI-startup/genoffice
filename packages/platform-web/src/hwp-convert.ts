/**
 * The browser's side of the `.hwp` → `.hwpx` conversion service.
 *
 * One `fetch`, and the reason it is a module rather than three lines at the call
 * site is that every app needs it: docs opens `.hwp` documents, and the AI panel
 * in docs, slides, sheets and pdf attaches them. Written once here, the same way
 * `attachment-extract.ts` is the one browser answer to "bytes → text".
 *
 * `available()` is separate from `toHwpx()` on purpose. The service can be
 * running while the JVM it shells out to is not, and a UI that offers `.hwp` in
 * a file dialog and then fails on every pick is worse than one that never
 * offered it. The check is cached for the life of the page: the answer is a
 * property of the deployment, so asking again per file would be a request per
 * dialog for a value that cannot change.
 *
 * `fetch` is injected for the same reason everything else in this package is:
 * these tests reach no network, and a host with a different transport has
 * somewhere to put it.
 */
import {
  CONVERT_ROUTES,
  HWP_MIME,
  type ConvertErrorBody,
  type ConvertHealthBody,
} from './convert-wire.js'

export type HwpConvertResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: ConvertErrorBody['reason'] | 'unreachable'; error: string }

export interface WebHwpConvertPort {
  /**
   * Whether a conversion would work right now.
   *
   * `false` for every reason it could be false — no service, no JVM, a proxy
   * that does not forward the route — because the caller's decision is the same
   * in all of them: do not offer `.hwp`.
   */
  available(): Promise<boolean>
  /** Convert one document. Never throws; a transport failure is `unreachable`. */
  toHwpx(bytes: Uint8Array): Promise<HwpConvertResult>
}

export interface WebHwpConvertOptions {
  fetchImpl?: typeof fetch
}

export function createWebHwpConvertPort(options: WebHwpConvertOptions = {}): WebHwpConvertPort {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let probe: Promise<boolean> | null = null

  const ask = async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(CONVERT_ROUTES.health)
      if (!response.ok) return false
      const body = (await response.json()) as ConvertHealthBody
      return body.converter === true
    } catch {
      // No service, or no route through the proxy. Either way there is nothing
      // to offer, and this is not an error worth showing anyone.
      return false
    }
  }

  return {
    available() {
      probe ??= ask()
      return probe
    },

    async toHwpx(bytes) {
      let response: Response
      try {
        response = await fetchImpl(CONVERT_ROUTES.hwpToHwpx, {
          method: 'POST',
          headers: { 'Content-Type': HWP_MIME },
          // A fresh copy, so a `Uint8Array` that is a view onto a larger pool
          // does not send the pool.
          body: bytes.slice(),
        })
      } catch (error) {
        return {
          ok: false,
          reason: 'unreachable',
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (!response.ok) {
        // The service answers errors as JSON; anything else came from whatever
        // sits in front of it, and the status is then all there is to report.
        const body = await response
          .json()
          .then((value) => value as ConvertErrorBody)
          .catch(() => null)
        return {
          ok: false,
          reason: body?.reason ?? 'failed',
          error: body?.error ?? `conversion service answered ${response.status}`,
        }
      }
      return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) }
    },
  }
}
