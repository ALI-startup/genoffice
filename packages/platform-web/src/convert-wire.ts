/** The HTTP contract between the browser and the format-conversion service. */

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

/** What the service answers with when it could not convert. */
export interface ConvertErrorBody {
  reason: 'unsupported' | 'invalid' | 'too-large' | 'timeout' | 'failed'
  error: string
}

/** What the health route answers. */
export interface ConvertHealthBody {
  ok: boolean
  converter: boolean
  /** Version of the bundled converter, for the logs; absent when unavailable. */
  version?: string
}
