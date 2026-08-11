/**
 * The two security properties the BFF exists to provide.
 *
 * 1. No fragment of a credential appears in any response body.
 * 2. A browser-supplied `settings` field is dropped, never honoured.
 *
 * Both are asserted against real bytes off a real socket, and both sweep *every*
 * route rather than the one obvious one — a leak is only interesting if it can
 * be found where nobody was looking.
 */
import { describe, expect, it } from 'vitest'
import { AI_BFF_ROUTES } from '@genoffice/platform-web/wire'
import { defaultAiSettings, resolveAiSettings } from '@genoffice/ai-provider'
import { SECRET_KEY, settingsWithSecret, sseChunks, startHarness } from './fakes.js'

/**
 * Every substring of the credential of length >= 4, which is what makes this a
 * "no fragment" check rather than a "no whole key" check. Length 4 is the floor
 * on purpose: it is exactly the size of the `••••1234` hint that
 * @genoffice/ai-electron's `toPublicAiSettings` keeps and the wire contract
 * deliberately drops, so a regression that reintroduced the hint would fail here.
 */
function fragments(secret: string, minLength = 4): string[] {
  const out = new Set<string>()
  for (let start = 0; start + minLength <= secret.length; start++) {
    for (let end = start + minLength; end <= secret.length; end++) {
      out.add(secret.slice(start, end))
    }
  }
  return [...out]
}

function assertNoFragment(body: string, secret: string): void {
  // Test the body against the fragments rather than the reverse: a single scan
  // of the fragment set is enough, and a failure names the exact substring that
  // escaped instead of just "something leaked".
  const found = fragments(secret).filter((fragment) => body.includes(fragment))
  expect(found, `response body leaked credential fragment(s): ${found.join(', ')}`).toEqual([])
}

describe('no credential fragment reaches the client', () => {
  it('is absent from every response body across every route', async () => {
    const harness = await startHarness({
      behavior: { deltas: ['hello'], stopReason: 'end_turn' },
    })
    try {
      await harness.get('/health')
      await harness.get(AI_BFF_ROUTES.settings)
      await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r1',
        system: 'sys',
        messages: [{ role: 'user', text: 'hi' }],
      })
      await harness.post(AI_BFF_ROUTES.chat, { system: 'sys', user: 'hi' })
      await harness.post(AI_BFF_ROUTES.streamCancel, { requestId: 'r1' })
      await harness.get('/nope')
      // Error paths too: a 400, a malformed body, and an oversized body all
      // produce text, and text is where a key would hide.
      await harness.post(AI_BFF_ROUTES.stream, { system: 'no request id' })
      await harness.post(AI_BFF_ROUTES.chat, 'not json at all')

      expect(harness.bodies.length).toBe(8)
      for (const body of harness.bodies) assertNoFragment(body, SECRET_KEY)
    } finally {
      await harness.close()
    }
  })

  it('redacts a credential echoed back inside a provider error message', async () => {
    // Real gateways do this: a 401 body can quote the Authorization header it
    // rejected, and @genoffice/ai-provider forwards the body verbatim.
    const harness = await startHarness({
      behavior: { throws: new Error(`HTTP 401: invalid key "${SECRET_KEY}"`) },
    })
    try {
      const { body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r1',
        system: 'sys',
        messages: [],
      })
      const chunks = sseChunks(body)
      const error = chunks.find((chunk) => chunk.type === 'error')
      expect(error?.error).toContain('[redacted]')
      assertNoFragment(body, SECRET_KEY)
    } finally {
      await harness.close()
    }
  })

  it('redacts a credential echoed back by the one-shot chat route', async () => {
    const harness = await startHarness({
      chatResult: { ok: false, error: `HTTP 403: key ${SECRET_KEY} is out of quota` },
    })
    try {
      const { body } = await harness.post(AI_BFF_ROUTES.chat, { system: 's', user: 'u' })
      expect(body).toContain('[redacted]')
      assertNoFragment(body, SECRET_KEY)
    } finally {
      await harness.close()
    }
  })

  it('reports which provider is usable without saying anything about the credential', async () => {
    const harness = await startHarness()
    try {
      const { body } = await harness.get(AI_BFF_ROUTES.settings)
      const view = JSON.parse(body) as {
        active: { providerId: string; model: string }
        providers: Record<string, { credentialConfigured: boolean }>
      }
      expect(view.active).toEqual({ providerId: 'anthropic', model: 'claude-test-1' })
      expect(view.providers.anthropic?.credentialConfigured).toBe(true)
      // The response has no key-shaped field at all, not even an empty one.
      expect(body).not.toContain('apiKey')
      expect(body).not.toContain('••••')
    } finally {
      await harness.close()
    }
  })
})

describe('a browser-supplied settings field is dropped, not honoured', () => {
  /** What a compromised page would send: its own endpoint and its own key. */
  const hostileSettings = resolveAiSettings(
    {
      provider: 'custom',
      providers: {
        ...defaultAiSettings().providers,
        custom: {
          apiKey: 'attacker-supplied-key',
          model: 'attacker-model',
          baseUrl: 'https://exfil.example/v1',
        },
      },
    },
    defaultAiSettings(),
  )

  it('streams with the server-chosen provider even when the body names another', async () => {
    const harness = await startHarness({ behavior: { deltas: ['hi'] } })
    try {
      const { body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r1',
        system: 'sys',
        messages: [{ role: 'user', text: 'hi' }],
        settings: hostileSettings,
        // A provider id smuggled in at the top level must be ignored too.
        provider: 'custom',
      })

      expect(harness.streamCalls.length).toBe(1)
      const call = harness.streamCalls[0]!
      expect(call.provider).toBe('anthropic')
      expect(call.config.apiKey).toBe(SECRET_KEY)
      expect(call.config.model).toBe('claude-test-1')
      // The decisive assertion: the attacker's endpoint was never contacted.
      expect(call.config.baseUrl).toBeUndefined()
      expect(sseChunks(body).some((chunk) => chunk.type === 'done')).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('ignores a hostile settings field on the one-shot chat route as well', async () => {
    const harness = await startHarness()
    try {
      await harness.post(AI_BFF_ROUTES.chat, {
        system: 'sys',
        user: 'hi',
        settings: hostileSettings,
      })
      const call = harness.chatCalls[0]!
      expect(call.provider).toBe('anthropic')
      expect(call.config.baseUrl).toBeUndefined()
      expect(call.config.apiKey).toBe(SECRET_KEY)
    } finally {
      await harness.close()
    }
  })

  it('refuses to stream at all when the server itself holds no credential', async () => {
    // The mirror image of the test above: with no server-side credential there
    // is no fallback to whatever the client offered — the run simply fails.
    const harness = await startHarness({ settings: defaultAiSettings() })
    try {
      const { body } = await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r1',
        system: 'sys',
        messages: [],
        settings: hostileSettings,
      })
      const error = sseChunks(body).find((chunk) => chunk.type === 'error')
      expect(error?.error).toContain('No credential is configured on the server')
      expect(harness.streamCalls.length).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('keeps the fields it does accept', async () => {
    // The point is not "ignore the body" but "ignore only the authority-bearing
    // parts of it": prompt, history, tools and token ceiling still come through.
    const harness = await startHarness({ behavior: { deltas: ['x'] } })
    try {
      await harness.post(AI_BFF_ROUTES.stream, {
        requestId: 'r1',
        system: 'you are a test',
        messages: [{ role: 'user', text: 'question' }],
        tools: [{ name: 'noop', description: 'does nothing', inputSchema: { type: 'object' } }],
        maxTokens: 128,
        settings: settingsWithSecret(),
      })
      const call = harness.streamCalls[0]!
      expect(call.system).toBe('you are a test')
      expect(call.messages).toEqual([{ role: 'user', text: 'question' }])
      expect(call.tools[0]?.name).toBe('noop')
      expect(call.maxTokens).toBe(128)
    } finally {
      await harness.close()
    }
  })
})
