/**
 * The AI backend-for-frontend.
 *
 * One job: be the only process that knows the provider credentials, and expose
 * exactly enough over HTTP for a browser renderer to run the same AI surface it
 * runs under Electron. The provider logic itself is not reimplemented — the
 * handlers below call @samugen/ai-provider's `streamForProvider` and
 * `chatForProvider`, the same functions the Electron main process calls, so
 * provider quirks are fixed in one place for both hosts.
 *
 * Shape of the seam: `AiPort` is an Electron-IPC-shaped contract (fire
 * `aiStream`, receive chunks on a separate subscription). SSE is its natural
 * HTTP form, so `POST /v1/ai/stream` answers with a stream of the very same
 * `AiStreamChunk` objects the IPC channel carries, `ping` keepalives included.
 *
 * `node:http` and nothing else. There are four routes, no middleware chain, no
 * templating and no static assets, so a framework would add a dependency and a
 * supply-chain surface to a credential-holding process in exchange for saving
 * about thirty lines of routing.
 *
 * Two deliberate omissions:
 *   - No CORS headers. The browser reaches this service same-origin through the
 *     dev server's `/v1/ai` proxy (the renderer CSP is `connect-src 'self'`), so
 *     any cross-origin caller is by definition not our page.
 *   - No client-supplied provider, endpoint, model or settings. The client names
 *     a *task*; the server chooses everything else. Accepting an endpoint from
 *     the browser would let a compromised page point the server's credentials
 *     wherever it liked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  AiCreditsError,
  AiTimeoutError,
  chatForProvider,
  streamForProvider,
  type AiChatResponse,
  type AiSettings,
  type AiStreamChunk,
} from '@samugen/ai-provider'
import type { AgentMessage, AgentToolDef } from '@samugen/agent-core'
import { AI_BFF_ROUTES } from '@samugen/platform-web/wire'
import { resolveProvider, toPublicSettings } from './credentials.js'

/** Streaming request bodies are prompts and tool schemas, not uploads. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_TOKENS = 8192
/** Wire keepalive so the renderer's silence watchdog can tell a slow turn from a dead one. */
const PING_INTERVAL_MS = 5_000

export interface AiBffOptions {
  settings: AiSettings
  /** Injected in tests; production uses @samugen/ai-provider. */
  stream?: typeof streamForProvider
  chat?: typeof chatForProvider
  maxBodyBytes?: number
  maxTokens?: number
}

export function createAiBffServer(options: AiBffOptions): Server {
  return createServer(createAiBffHandler(options))
}

export function createAiBffHandler(
  options: AiBffOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { settings } = options
  const stream = options.stream ?? streamForProvider
  const chat = options.chat ?? chatForProvider
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const redact = createRedactor(settings)
  /** In-flight streams by requestId, so the cancel route can abort them. */
  const active = new Map<string, AbortController>()

  return (req, res) => {
    void route(req, res).catch((error: unknown) => {
      // Last-resort guard: a handler bug must not leave the socket hanging, and
      // the message goes out redacted like every other error text. An oversized
      // body is the one expected failure that lands here, and it gets its own
      // status so a client can tell "too big" from "we broke".
      const status = error instanceof BodyTooLargeError ? 413 : 500
      if (!res.headersSent) sendJson(res, status, { error: redact(errorText(error)) })
      else res.end()
    })
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only the path matters; a query string is never part of any route here.
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'GET' && path === AI_BFF_ROUTES.settings) {
      return sendJson(res, 200, toPublicSettings(settings))
    }
    if (method === 'POST' && path === AI_BFF_ROUTES.streamCancel) {
      const body = await readJson(req, maxBodyBytes)
      const requestId = asString(body?.requestId)
      if (!requestId) return sendJson(res, 400, { error: 'requestId is required' })
      const controller = active.get(requestId)
      controller?.abort()
      active.delete(requestId)
      // `canceled: false` for an unknown id: the run had already finished, which
      // is a normal race between the stop button and the last chunk.
      return sendJson(res, 200, { ok: true, canceled: Boolean(controller) })
    }
    if (method === 'POST' && path === AI_BFF_ROUTES.stream) {
      return handleStream(req, res)
    }
    if (method === 'POST' && path === AI_BFF_ROUTES.chat) {
      return handleChat(req, res)
    }
    sendJson(res, 404, { error: `No route for ${method} ${path}` })
  }

  async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, maxBodyBytes)
    const requestId = asString(body?.requestId)
    if (!requestId) return sendJson(res, 400, { error: 'requestId is required' })
    const system = asString(body?.system) ?? ''
    const messages = Array.isArray(body?.messages) ? (body.messages as AgentMessage[]) : []
    const tools = Array.isArray(body?.tools) ? (body.tools as AgentToolDef[]) : []
    // `settings` is the deprecated renderer-supplied field. Dropping it here is
    // the enforcement point for "the browser does not choose the provider".
    // `task` is accepted but the active provider is server-chosen either way.

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Stops reverse proxies from buffering the stream into one response.
      'x-accel-buffering': 'no',
    })
    const send = (chunk: AiStreamChunk) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    const provider = resolveProvider(settings)
    if (!provider.ok) {
      send({ requestId, type: 'error', error: redact(provider.error) })
      res.end()
      return
    }

    const controller = new AbortController()
    active.set(requestId, controller)
    // A closed socket (tab closed, navigation) must stop the upstream call too,
    // otherwise a cancelled run keeps burning the server's own credits.
    const onClose = () => controller.abort()
    req.on('close', onClose)

    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < PING_INTERVAL_MS) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }

    try {
      let stopReason: string | undefined
      await stream(
        provider.resolved.provider,
        provider.resolved.config,
        system,
        messages,
        tools,
        typeof body?.maxTokens === 'number' ? body.maxTokens : maxTokens,
        {
          signal: controller.signal,
          onDelta: (text) => send({ requestId, type: 'delta', text }),
          onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
          onActivity: ping,
          onStopReason: (reason) => {
            stopReason = reason
          },
        },
      )
      send({ requestId, type: 'done', ...(stopReason ? { stopReason } : {}) })
    } catch (error) {
      if (controller.signal.aborted) {
        send({ requestId, type: 'done' })
      } else {
        send({
          requestId,
          type: 'error',
          error: redact(errorText(error)),
          ...(error instanceof AiTimeoutError
            ? { errorCode: 'timeout' as const }
            : error instanceof AiCreditsError
              ? { errorCode: 'credits' as const }
              : {}),
        })
      }
    } finally {
      req.off('close', onClose)
      active.delete(requestId)
      res.end()
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, maxBodyBytes)
    const provider = resolveProvider(settings)
    if (!provider.ok) {
      return sendJson(res, 200, {
        ok: false,
        error: redact(provider.error),
      } satisfies AiChatResponse)
    }
    let result: AiChatResponse
    try {
      result = await chat(
        provider.resolved.provider,
        provider.resolved.config,
        asString(body?.system) ?? '',
        asString(body?.user) ?? '',
      )
    } catch (error) {
      result = { ok: false, error: errorText(error) }
    }
    sendJson(res, 200, {
      ...result,
      ...(result.error === undefined ? {} : { error: redact(result.error) }),
    } satisfies AiChatResponse)
  }
}

/**
 * Redact every configured credential from any text on its way out.
 *
 * Belt and braces on top of never putting a key in a response: a provider's own
 * error body can echo the credential it rejected (some gateways include the
 * offending Authorization header), and that body is forwarded verbatim by
 * @samugen/ai-provider's `HTTP <status>: <detail>` messages. Filtering at the
 * single point where text becomes a response body means no future handler can
 * reintroduce the leak.
 */
export function createRedactor(settings: AiSettings): (text: string) => string {
  const configs = Object.values(settings.providers ?? {})
  const secrets = [
    ...new Set(
      [
        ...configs.map((config) => config?.apiKey),
        // Operator-configured headers are usually attribution ("X-Caller"), but
        // nothing stops one carrying a gateway token, so the auth-shaped ones are
        // treated as credentials too. Matching on the *name* keeps an ordinary
        // tracking value from being scrubbed out of otherwise readable errors.
        ...configs.flatMap((config) =>
          Object.entries(config?.headers ?? {})
            .filter(([name]) => /authorization|api[-_]?key|token|secret|credential/i.test(name))
            .map(([, value]) => value),
        ),
      ].filter((key): key is string => typeof key === 'string' && key.length >= 8),
    ),
  ]
  if (secrets.length === 0) return (text) => text
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Raised when a request body passes the cap, so the handler can answer 413 rather than 500. */
export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError'
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
  }
}

/**
 * Read a JSON body with a hard size cap. A malformed body yields undefined; an
 * oversized one throws.
 *
 * The request stream is abandoned rather than destroyed: destroying the socket
 * here would kill it before the 413 could be written, so the client would see a
 * transport error instead of the reason it was refused. Node stops reusing a
 * connection whose request was not drained and closes it once the response is
 * flushed, so nothing is left hanging either way.
 */
async function readJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
