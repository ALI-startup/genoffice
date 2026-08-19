import { describe, expect, it, vi } from 'vitest'
import type { AiStreamChunk } from '@samugen/ai-provider'
import { createWebAiPort, toAiSettings } from '../src/ai'
import { AI_BFF_ROUTES, type PublicAiSettings } from '../src/ai-wire'

const publicSettings: PublicAiSettings = {
  version: 1,
  active: { providerId: 'anthropic', model: 'claude-sonnet-4' },
  providers: {
    anthropic: {
      providerId: 'anthropic',
      model: 'claude-sonnet-4',
      credentialConfigured: true,
    },
  },
}

/**
 * A fetch mock typed as fetch itself, so `mock.calls` carries fetch's real
 * argument tuple and the mock is assignable to the port's `fetch` option
 * without a cast. `vi.fn(async () => ...)` infers an empty parameter list,
 * which makes every `mock.calls[0][0]` read a type error.
 */
function typedFetchMock(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return vi.fn(impl)
}

function sseResponse(chunks: AiStreamChunk[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

describe('toAiSettings', () => {
  it('never produces an API key, because the browser never has one', () => {
    const settings = toAiSettings(publicSettings)

    expect(settings.provider).toBe('anthropic')
    expect(Object.values(settings.providers).every((config) => config.apiKey === '')).toBe(true)
  })

  it('carries the server-chosen model through and defaults the rest', () => {
    const settings = toAiSettings(publicSettings)

    expect(settings.providers.anthropic.model).toBe('claude-sonnet-4')
    expect(settings.providers.openai.model).not.toBe('')
  })
})

describe('aiStream', () => {
  it('forwards SSE chunks to subscribers', async () => {
    const chunks: AiStreamChunk[] = [
      { requestId: 'r1', type: 'delta', text: 'hi' },
      { requestId: 'r1', type: 'done' },
    ]
    const fetchMock = typedFetchMock(async () => sseResponse(chunks))
    const port = createWebAiPort({ fetch: fetchMock })
    const seen: AiStreamChunk[] = []
    port.onAiStream((chunk) => seen.push(chunk))

    await port.aiStream({ requestId: 'r1', system: 's', messages: [] })

    expect(seen).toEqual(chunks)
  })

  it('never sends renderer-supplied settings to the server', async () => {
    const fetchMock = typedFetchMock(async () => sseResponse([{ requestId: 'r1', type: 'done' }]))
    const port = createWebAiPort({ fetch: fetchMock })

    await port.aiStream({
      requestId: 'r1',
      system: 's',
      messages: [],
      // The deprecated field a compromised page might try to use to point the
      // server's credentials somewhere else.
      settings: { provider: 'custom', providers: {} as never },
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(AI_BFF_ROUTES.stream)
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('settings')
  })

  it('reports a failed request as an error chunk rather than rejecting', async () => {
    const fetchMock = typedFetchMock(async () => new Response('nope', { status: 502 }))
    const port = createWebAiPort({ fetch: fetchMock })
    const seen: AiStreamChunk[] = []
    port.onAiStream((chunk) => seen.push(chunk))

    await expect(
      port.aiStream({ requestId: 'r1', system: 's', messages: [] }),
    ).resolves.toBeUndefined()
    expect(seen).toEqual([{ requestId: 'r1', type: 'error', error: 'AI request failed: HTTP 502' }])
  })

  it('ignores chunks belonging to another request', async () => {
    const fetchMock = typedFetchMock(async () =>
      sseResponse([
        { requestId: 'other', type: 'delta', text: 'leak' },
        { requestId: 'r1', type: 'done' },
      ]),
    )
    const port = createWebAiPort({ fetch: fetchMock })
    const seen: AiStreamChunk[] = []
    port.onAiStream((chunk) => seen.push(chunk))

    await port.aiStream({ requestId: 'r1', system: 's', messages: [] })

    expect(seen).toEqual([{ requestId: 'r1', type: 'done' }])
  })
})

describe('aiStreamCancel', () => {
  it('aborts the in-flight response and tells the server', async () => {
    let abortSignal: AbortSignal | undefined
    const fetchMock = typedFetchMock(async (url, init) => {
      if (url === AI_BFF_ROUTES.stream) {
        abortSignal = init?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(abortError()))
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    const port = createWebAiPort({ fetch: fetchMock })
    const seen: AiStreamChunk[] = []
    port.onAiStream((chunk) => seen.push(chunk))

    const running = port.aiStream({ requestId: 'r1', system: 's', messages: [] })
    await Promise.resolve()
    await port.aiStreamCancel('r1')
    await running

    expect(abortSignal?.aborted).toBe(true)
    // A cancel ends the run; it is not a failure, so the transport sees 'done'.
    expect(seen).toEqual([{ requestId: 'r1', type: 'done' }])
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(AI_BFF_ROUTES.streamCancel)
  })
})

describe('getAiSettings', () => {
  it('reads the public settings from the BFF', async () => {
    const fetchMock = typedFetchMock(async () => Response.json(publicSettings))
    const port = createWebAiPort({ fetch: fetchMock })

    const settings = await port.getAiSettings()

    expect(fetchMock.mock.calls[0]?.[0]).toBe(AI_BFF_ROUTES.settings)
    expect(settings.provider).toBe('anthropic')
  })

  it('surfaces a server failure instead of returning empty settings', async () => {
    const fetchMock = typedFetchMock(async () => new Response('no', { status: 500 }))
    const port = createWebAiPort({ fetch: fetchMock })

    await expect(port.getAiSettings()).rejects.toThrow('HTTP 500')
  })
})

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
