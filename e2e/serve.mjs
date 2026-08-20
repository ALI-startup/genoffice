/**
 * Static server for the composed web bundle, for the E2E run.
 *
 * The apps are plain files, so this is deliberately the smallest thing that
 * serves the bundle the way nginx does in docker/nginx: correct content types (a
 * wrong one for .wasm breaks the sheets engine), a directory index, and one
 * proxy. Playwright starts it via the config's `webServer`.
 *
 * The proxy is `/v1/convert`, and it exists because a `.hwp` cannot be opened
 * without it: the pages set `connect-src 'self'`, so the conversion request has
 * to come from this origin (nginx does the same job in a deployment). It is
 * conditional on E2E_CONVERT_URL — the AI BFF is not proxied at all because no
 * test exercises it, and the same would be true here if the Hangul tests did not
 * need a real converter behind them.
 */
import { createServer, request as httpRequest } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../apps/shell/dist/web')
const PORT = Number(process.env.E2E_WEB_PORT) || 4180
/** Where the `.hwp` → `.hwpx` service is listening, when a run has one. */
const CONVERT_URL = process.env.E2E_CONVERT_URL || ''
const CONVERT_PREFIX = '/v1/convert'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
}

/** Resolve a URL path inside ROOT, or null when it escapes it. */
function resolveInRoot(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  const candidate = resolve(join(ROOT, normalize(decoded)))
  return candidate === ROOT || candidate.startsWith(ROOT + '/') ? candidate : null
}

/** Pipe one request through to the conversion service, headers and body intact. */
function proxyConvert(request, response) {
  const upstream = new URL(CONVERT_URL)
  const forwarded = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: upstream.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    },
  )
  forwarded.on('error', (error) => {
    // 502, not a crash: a run without the service should see the same thing a
    // deployment without it sees, which the page reports as unavailable.
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ reason: 'unsupported', error: String(error) }))
  })
  request.pipe(forwarded)
}

createServer(async (request, response) => {
  if (CONVERT_URL && (request.url ?? '').startsWith(CONVERT_PREFIX)) {
    proxyConvert(request, response)
    return
  }
  const target = resolveInRoot(request.url ?? '/')
  if (!target) {
    response.writeHead(403).end('forbidden')
    return
  }
  let file = target
  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, 'index.html')
    await stat(file)
  } catch {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(file).pipe(response)
}).listen(PORT, () => {
  process.stdout.write(`serving ${ROOT} on http://127.0.0.1:${PORT}\n`)
})
