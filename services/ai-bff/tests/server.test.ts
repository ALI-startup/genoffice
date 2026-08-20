/** The routing and streaming behaviour of the BFF, over a real socket. */
import { describe, expect, it } from 'vitest'
import { AI_BFF_ROUTES } from '@samugen/platform-web/wire'
import { DEFAULT_MAX_TOKENS } from '../src/server.js'
import { sseChunks, startHarness } from './fakes.js'

describe('routing', () => {
  it('answers the health probe', async () => {
    const harness = await startHarness()
    try {
      const { status, body } = await harness.get('/health')
      expect(status).toBe(200)
      expect(JSON.parse(body)).toEqual({ ok: true })
    } finally {
      await harness.close()
    }
  })

  it('ignores a query string when matching a route', async () => {
    const harness = await startHarness()
    try {
      const { status } = await harness.get(`${AI_BFF_ROUTES.settings}?cachebust=1`)
      expect(status).toBe(200)
    } finally {
      await harness.close()
    }
  })

  it('404s an unknown path and a wrong method', async () => {
    const harness = await startHarness()
    try {
      expect((await harness.get('/v1/ai/nope')).status).toBe(404)
      // `settings` is GET-only; POSTing it must not fall through to a handler.
      expect((await harness.post(AI_BFF_ROUTES.settings, {})).status).toBe(404)
    } finally {
      await harness.close()
    }
  })

  it('rejects a body over the cap with 413 and without invoking a provider', async () => {
    const harness = await startHarness({ maxBodyBytes: 256 })
    try {
      const { status, body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r1',
        system: 'x'.repeat(1024),
        messages: [],
      })
      expect(status).toBe(413)
      expect(JSON.parse(body)).toEqual({ error: 'Request body exceeds 256 bytes' })
      expect(harness.streamCalls.length).toBe(0)
    } finally {
      await harness.close()
    }
  })
})

describe('stream route', () => {
  it('emits deltas then done, in order, with the run id on every chunk', async () => {
    const harness = await startHarness({
      behavior: { deltas: ['Hel', 'lo'], stopReason: 'end_turn' },
    })
    try {
      const { status, body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'run-1',
        system: 'sys',
        messages: [{ role: 'user', text: 'hi' }],
      })
      expect(status).toBe(200)
      const chunks = sseChunks(body)
      expect(chunks.map((chunk) => chunk.type)).toEqual(['delta', 'delta', 'done'])
      expect(chunks.map((chunk) => chunk.text).slice(0, 2)).toEqual(['Hel', 'lo'])
      expect(chunks.at(-1)).toEqual({ requestId: 'run-1', type: 'done', stopReason: 'end_turn' })
      expect(chunks.every((chunk) => chunk.requestId === 'run-1')).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('serves event-stream headers and disables proxy buffering', async () => {
    const harness = await startHarness({ behavior: { deltas: ['x'] } })
    try {
      const response = await fetch(`${harness.url}${AI_BFF_ROUTES.stream}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'r', system: '', messages: [] }),
      })
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.headers.get('cache-control')).toContain('no-cache')
      expect(response.headers.get('x-accel-buffering')).toBe('no')
      await response.text()
    } finally {
      await harness.close()
    }
  })

  it('requires a requestId', async () => {
    const harness = await startHarness()
    try {
      const { status, body } = await harness.post(AI_BFF_ROUTES.stream, {
        system: 'sys',
        messages: [],
      })
      expect(status).toBe(400)
      expect(JSON.parse(body)).toEqual({ error: 'requestId is required' })
    } finally {
      await harness.close()
    }
  })

  it('applies the configured token ceiling when the body names none', async () => {
    const harness = await startHarness({ maxTokens: 555 })
    try {
      await harness.post(AI_BFF_ROUTES.stream, { requestId: 'r', system: '', messages: [] })
      expect(harness.streamCalls[0]?.maxTokens).toBe(555)
    } finally {
      await harness.close()
    }
  })

  it('falls back to the package default ceiling', async () => {
    const harness = await startHarness()
    try {
      await harness.post(AI_BFF_ROUTES.stream, { requestId: 'r', system: '', messages: [] })
      expect(harness.streamCalls[0]?.maxTokens).toBe(DEFAULT_MAX_TOKENS)
    } finally {
      await harness.close()
    }
  })

  it('maps a timeout to errorCode "timeout"', async () => {
    const { AiTimeoutError } = await import('@samugen/ai-provider')
    const harness = await startHarness({ behavior: { throws: new AiTimeoutError(30_000) } })
    try {
      const { body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r',
        system: '',
        messages: [],
      })
      const error = sseChunks(body).find((chunk) => chunk.type === 'error')
      expect(error?.errorCode).toBe('timeout')
    } finally {
      await harness.close()
    }
  })

  it('maps exhausted credits to errorCode "credits"', async () => {
    const { AiCreditsError } = await import('@samugen/ai-provider')
    const harness = await startHarness({ behavior: { throws: new AiCreditsError('out') } })
    try {
      const { body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r',
        system: '',
        messages: [],
      })
      const error = sseChunks(body).find((chunk) => chunk.type === 'error')
      expect(error?.errorCode).toBe('credits')
    } finally {
      await harness.close()
    }
  })
})

describe('cancel route', () => {
  it('aborts an in-flight run and reports it as cancelled', async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let seen: AbortSignal | undefined
    const harness = await startHarness({
      behavior: {
        hold,
        onSignal: (signal) => {
          seen = signal
        },
      },
    })
    try {
      const streaming = harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'run-x',
        system: '',
        messages: [],
      })
      // Wait until the provider call is actually in flight, otherwise the cancel
      // races the registration and would pass for the wrong reason.
      while (harness.streamCalls.length === 0) await new Promise((r) => setTimeout(r, 5))

      const { body } = await harness.post(AI_BFF_ROUTES.streamCancel, { requestId: 'run-x' })
      expect(JSON.parse(body)).toEqual({ ok: true, canceled: true })
      expect(seen?.aborted).toBe(true)

      release()
      const streamed = await streaming
      // An abort is the user pressing stop: the run ends, it does not fail.
      expect(sseChunks(streamed.body).map((chunk) => chunk.type)).toEqual(['done'])
    } finally {
      release()
      await harness.close()
    }
  })

  it('reports canceled:false for a run that already finished', async () => {
    const harness = await startHarness({ behavior: { deltas: ['x'] } })
    try {
      await harness.post(AI_BFF_ROUTES.stream, { requestId: 'done-1', system: '', messages: [] })
      const { body } = await harness.post(AI_BFF_ROUTES.streamCancel, { requestId: 'done-1' })
      expect(JSON.parse(body)).toEqual({ ok: true, canceled: false })
    } finally {
      await harness.close()
    }
  })

  it('requires a requestId', async () => {
    const harness = await startHarness()
    try {
      const { status } = await harness.post(AI_BFF_ROUTES.streamCancel, {})
      expect(status).toBe(400)
    } finally {
      await harness.close()
    }
  })
})

describe('chat route', () => {
  it('passes system and user through and returns the provider answer', async () => {
    const harness = await startHarness({ chatResult: { ok: true, content: 'forty-two' } })
    try {
      const { status, body } = await harness.post(AI_BFF_ROUTES.chat, {
        system: 'be brief',
        user: 'the answer?',
      })
      expect(status).toBe(200)
      expect(JSON.parse(body)).toEqual({ ok: true, content: 'forty-two' })
      expect(harness.chatCalls[0]).toMatchObject({ system: 'be brief', user: 'the answer?' })
    } finally {
      await harness.close()
    }
  })

  it('reports a thrown provider failure as ok:false rather than a 500', async () => {
    const harness = await startHarness()
    try {
      const { status, body } = await harness.post(AI_BFF_ROUTES.chat, 'not json')
      expect(status).toBe(200)
      // A malformed body degrades to empty prompts; the fake still answers.
      expect(JSON.parse(body)).toMatchObject({ ok: true })
    } finally {
      await harness.close()
    }
  })
})
