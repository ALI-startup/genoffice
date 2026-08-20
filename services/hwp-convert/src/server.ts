/** The format-conversion service. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  CONVERT_ROUTES,
  HWPX_MIME,
  type ConvertErrorBody,
  type ConvertHealthBody,
} from '@samugen/platform-web/convert-wire'
import {
  convertHwpToHwpx,
  converterAvailable,
  DEFAULT_TIMEOUT_MS,
  type ConvertOptions,
} from './convert.js'

/**
 * Documents, not prompts, so the limit is the one nginx already allows through
 * (`client_max_body_size 64m`).
 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024

export interface HwpConvertOptions extends ConvertOptions {
  maxBodyBytes?: number
}

export function createHwpConvertServer(options: HwpConvertOptions = {}): Server {
  return createServer(createHwpConvertHandler(options))
}

export function createHwpConvertHandler(
  options: HwpConvertOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const convertOptions: ConvertOptions = {
    jar: options.jar,
    javaBin: options.javaBin,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    runJava: options.runJava,
  }

  return (req, res) => {
    void route(req, res).catch((error: unknown) => {
      // Nothing in `route` throws for a caller-visible condition, so reaching
      // here means this process is broken rather than the request being bad.
      if (!res.headersSent) {
        sendError(res, 500, 'failed', error instanceof Error ? error.message : String(error))
      } else {
        res.end()
      }
    })
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the path matters; no route here takes a query string.
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'

    // Both spellings answer: `/health` is what a container health check reaches
    // directly, and the prefixed one is what survives a same-origin proxy that
    // only forwards this service's route prefix.
    if (method === 'GET' && (path === '/health' || path === CONVERT_ROUTES.health)) {
      const converter = await converterAvailable(convertOptions)
      const body: ConvertHealthBody = { ok: true, converter }
      sendJson(res, 200, body)
      return
    }

    if (path === CONVERT_ROUTES.hwpToHwpx) {
      if (method !== 'POST') {
        sendError(res, 405, 'failed', `Use POST for ${CONVERT_ROUTES.hwpToHwpx}`)
        return
      }
      const body = await readBody(req, maxBodyBytes)
      if (body === 'too-large') {
        sendError(res, 413, 'too-large', `body exceeds ${maxBodyBytes} bytes`)
        return
      }
      if (body.length === 0) {
        sendError(res, 400, 'invalid', 'empty body')
        return
      }
      const result = await convertHwpToHwpx(body, convertOptions)
      if (!result.ok) {
        // The status separates "your file" from "our deployment", which is what
        // decides whether the UI tells the user to try another file.
        const status =
          result.reason === 'invalid'
            ? 400
            : result.reason === 'timeout'
              ? 504
              : result.reason === 'unsupported'
                ? 503
                : 422
        sendError(res, status, result.reason, result.error)
        return
      }
      res.writeHead(200, {
        'Content-Type': HWPX_MIME,
        'Content-Length': String(result.bytes.byteLength),
        'Cache-Control': 'no-store',
      })
      res.end(result.bytes)
      return
    }

    sendError(res, 404, 'failed', `No route for ${method} ${path}`)
  }
}

/** Read the whole body, or refuse. */
async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | 'too-large'> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > limit) {
      req.destroy()
      return 'too-large'
    }
    chunks.push(buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function sendError(
  res: ServerResponse,
  status: number,
  reason: ConvertErrorBody['reason'],
  error: string,
): void {
  sendJson(res, status, { reason, error } satisfies ConvertErrorBody)
}
