/**
 * The HTTP contract between the browser and the format-conversion service.
 *
 * Types and route names only, with no DOM or Node reference, for the same reason
 * `ai-wire.ts` is shaped that way: the service imports this module to type what
 * it answers and the browser adapter imports it to type what it parses, so the
 * two sides cannot drift.
 *
 * Why a service at all, in an app that otherwise converts everything in the
 * page: `.hwp` is the HWP 5.0 binary — an OLE compound document of compressed
 * record streams — and the only complete implementation of it is `hwplib`, a
 * Java library. There is no browser build of it and no JavaScript equivalent
 * that reads a real file (the one that advertises itself as such returns a
 * hard-coded sentence). So the honest options were a server-side converter or no
 * `.hwp` support, and this is the first.
 *
 * The response is bytes, not JSON: it is a `.hwpx` package on its way into
 * @samugen/hwpx-convert, and base64 in a JSON envelope would cost a third of the
 * size in transfer for nothing. Errors are JSON, because they are read.
 */

/** Route prefix the browser calls, and the path a deployment proxies to the service. */
export const CONVERT_BASE_PATH = '/v1/convert'

export const CONVERT_ROUTES = {
  /** POST: `.hwp` bytes in the body, `.hwpx` bytes in the response. */
  hwpToHwpx: `${CONVERT_BASE_PATH}/hwp-to-hwpx`,
  health: `${CONVERT_BASE_PATH}/health`,
} as const

/** Content type of an OWPML package, as the service labels its output. */
export const HWPX_MIME = 'application/hwp+zip'

/** Content type of the legacy binary, as the browser labels its request. */
export const HWP_MIME = 'application/x-hwp'

/**
 * What the service answers with when it could not convert.
 *
 * `reason` is a stable token for the caller to branch on; `error` is the
 * human-readable detail, which for a conversion failure is the converter's own
 * stderr and therefore worth showing.
 *
 *   - `unsupported` — the service is running but has no converter available
 *     (no JVM, or the JAR is missing). A deployment problem, not a bad file.
 *   - `invalid` — the bytes are not an HWP 5.0 document.
 *   - `too-large` — the body exceeded the service's limit.
 *   - `timeout` — the converter did not finish in time.
 *   - `failed` — it ran and refused, which is the ordinary corrupt-file answer.
 */
export interface ConvertErrorBody {
  reason: 'unsupported' | 'invalid' | 'too-large' | 'timeout' | 'failed'
  error: string
}

/**
 * What the health route answers.
 *
 * `converter` is what makes it worth having: the process can be up and listening
 * while the JVM it shells out to is absent, and a browser needs to know that
 * before it offers a `.hwp` in a file dialog.
 */
export interface ConvertHealthBody {
  ok: boolean
  converter: boolean
  /** Version of the bundled converter, for the logs; absent when unavailable. */
  version?: string
}
