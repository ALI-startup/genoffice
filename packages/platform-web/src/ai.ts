/**
 * AiPort over the AI BFF.
 *
 * The shape of `AiPort` is the Electron IPC shape — fire `aiStream`, receive
 * chunks through a separate `onAiStream` subscription — and it maps onto HTTP
 * without distortion: the POST body is the request, and the SSE response body
 * is the chunk channel. `@genoffice/agent-core`'s `createIpcTransport`
 * therefore drives this adapter unchanged, pings and silence watchdog included.
 *
 * No credential ever reaches this file. `getAiSettings` returns what the server
 * is willing to say about itself, and `aiStream` names a task; the server picks
 * the provider and holds the key. That is the whole point of the BFF, and it is
 * why the returned `AiSettings.apiKey` is the empty string — see below.
 */
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import { AI_PROVIDERS, sseLines } from '@genoffice/ai-provider'
import type { AiPort } from '@genoffice/platform'
import { AI_BFF_ROUTES, type AiStreamBody, type PublicAiSettings } from './ai-wire.js'

export interface WebAiPortOptions {
  /** Absolute or same-origin base; defaults to the BFF routes on this origin. */
  routes?: typeof AI_BFF_ROUTES
  fetch?: typeof globalThis.fetch
}

/**
 * Map the server's public view onto the `AiSettings` shape the port declares.
 *
 * `apiKey` is `''` for every provider, and that is the honest value: the
 * browser has no key and must never be given one. `credentialConfigured` is
 * what actually says whether a provider is usable, and the server enforces it —
 * a request for a provider without a credential comes back as an error chunk
 * rather than being silently attempted.
 */
export function toAiSettings(publicSettings: PublicAiSettings): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const meta of AI_PROVIDERS) {
    const entry = publicSettings.providers[meta.id]
    providers[meta.id] = {
      apiKey: '',
      model: entry?.model ?? meta.defaultModel,
      baseUrl: entry?.baseUrl ?? (meta.needsBaseUrl ? '' : undefined),
    }
  }
  return { provider: publicSettings.active.providerId, providers }
}

/**
 * Fetch the server's public view of its own AI configuration, unmapped.
 *
 * `toAiSettings` exists to satisfy `AiPort`, and in doing so it drops the one
 * field a *settings screen* needs: `credentialConfigured`. It has to — the
 * `AiSettings` shape has an `apiKey` and no notion of "the server holds one",
 * so the boolean has nowhere to go and becomes `apiKey: ''` for configured and
 * unconfigured providers alike.
 *
 * The shell's read-only AI Providers page reads this instead. It is the same
 * request to the same route; what differs is that nothing is discarded. There is
 * still no credential in the response and cannot be — the BFF's no-leak test
 * asserts that no four-character run of any credential appears in any response
 * body, which is exactly why this view can show *whether* a provider is
 * configured and never a masked hint of the key.
 */
export async function fetchPublicAiSettings(
  options: WebAiPortOptions = {},
): Promise<PublicAiSettings> {
  const routes = options.routes ?? AI_BFF_ROUTES
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await doFetch(routes.settings, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`AI settings request failed: HTTP ${response.status}`)
  return (await response.json()) as PublicAiSettings
}

export function createWebAiPort(options: WebAiPortOptions = {}): AiPort {
  const routes = options.routes ?? AI_BFF_ROUTES
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const listeners = new Set<(chunk: AiStreamChunk) => void>()
  /** In-flight requests, so a cancel can abort the response body immediately. */
  const inFlight = new Map<string, AbortController>()

  const emit = (chunk: AiStreamChunk) => {
    for (const listener of listeners) listener(chunk)
  }

  return {
    async getAiSettings(): Promise<AiSettings> {
      const response = await doFetch(routes.settings, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`AI settings request failed: HTTP ${response.status}`)
      return toAiSettings((await response.json()) as PublicAiSettings)
    },

    /**
     * Resolves when the stream ends, not when it starts.
     *
     * `createIpcTransport` only uses the returned promise to catch a failure to
     * start, and treats the run as finished when a `done` or `error` chunk
     * arrives — so a late resolve is harmless, while a late *rejection* would
     * race the chunk that already settled the run. Everything is therefore
     * reported as an error chunk and the promise always resolves.
     */
    async aiStream(request: AiStreamRequest): Promise<void> {
      const { requestId } = request
      // Strip `settings` on the way out as well as on the way in: the browser
      // is not the authority on which provider or endpoint gets used.
      const body: AiStreamBody = {
        requestId,
        system: request.system,
        messages: request.messages,
        ...(request.task === undefined ? {} : { task: request.task }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      }
      const controller = new AbortController()
      inFlight.set(requestId, controller)
      try {
        const response = await doFetch(routes.stream, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          emit({
            requestId,
            type: 'error',
            error: `AI request failed: HTTP ${response.status}`,
          })
          return
        }
        for await (const line of sseLines(response.body)) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          // The server owns requestId; ignore anything that is not this run's.
          const chunk = JSON.parse(payload) as AiStreamChunk
          if (chunk.requestId === requestId) emit(chunk)
        }
      } catch (error) {
        // An abort is the user pressing stop: the run is over, not failed.
        if (controller.signal.aborted) emit({ requestId, type: 'done' })
        else emit({ requestId, type: 'error', error: errorText(error) })
      } finally {
        inFlight.delete(requestId)
      }
    },

    async aiStreamCancel(requestId: string): Promise<void> {
      // Abort locally first so the UI stops immediately even if the server is
      // slow to notice; the POST then stops the upstream provider call too.
      inFlight.get(requestId)?.abort()
      inFlight.delete(requestId)
      await doFetch(routes.streamCancel, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId }),
      }).catch(() => undefined)
    },

    onAiStream(handler: (chunk: AiStreamChunk) => void): () => void {
      listeners.add(handler)
      return () => void listeners.delete(handler)
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
