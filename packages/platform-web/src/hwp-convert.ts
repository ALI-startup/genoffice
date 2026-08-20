/** The browser's side of the `.hwp` → `.hwpx` conversion service. */
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
  /** Whether a conversion would work right now. */
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
      // No service, or no route through the proxy.
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
