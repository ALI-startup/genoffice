/**
 * The credential boundary: what comes in from the environment, and what the one
 * outward-facing projection of it is allowed to contain.
 */
import { describe, expect, it } from 'vitest'
import { AI_PROVIDERS, defaultAiSettings } from '@genoffice/ai-provider'
import {
  isProviderId,
  loadAiSettings,
  resolveProvider,
  toPublicSettings,
  type Env,
} from '../src/credentials.js'
import { createRedactor } from '../src/server.js'
import { SECRET_KEY, settingsWithSecret } from './fakes.js'

describe('loadAiSettings', () => {
  it('reads a credential, a model and a base URL per provider', () => {
    const env: Env = {
      GENOFFICE_AI_PROVIDER: 'anthropic',
      GENOFFICE_AI_KEY_ANTHROPIC: SECRET_KEY,
      GENOFFICE_AI_MODEL_ANTHROPIC: 'claude-test-1',
    }
    const settings = loadAiSettings(env)
    expect(settings.provider).toBe('anthropic')
    expect(settings.providers.anthropic).toMatchObject({
      apiKey: SECRET_KEY,
      model: 'claude-test-1',
    })
  })

  it('has a working env var for every provider the app knows about', () => {
    // The whole roster, not a sample: the env name is derived from the id
    // (upper-cased, `-` → `_`), so a provider added upstream with a hyphen in
    // its id must still be configurable without touching this service.
    for (const meta of AI_PROVIDERS) {
      const suffix = meta.id.toUpperCase().replace(/-/g, '_')
      const settings = loadAiSettings({ [`GENOFFICE_AI_KEY_${suffix}`]: SECRET_KEY })
      expect(settings.providers[meta.id].apiKey, `no env var maps to ${meta.id}`).toBe(SECRET_KEY)
    }
  })

  it('trims surrounding whitespace, which shell exports pick up easily', () => {
    const settings = loadAiSettings({
      GENOFFICE_AI_PROVIDER: '  anthropic  ',
      GENOFFICE_AI_KEY_ANTHROPIC: `  ${SECRET_KEY}\n`,
    })
    expect(settings.provider).toBe('anthropic')
    expect(settings.providers.anthropic?.apiKey).toBe(SECRET_KEY)
  })

  it('ignores an unknown provider id rather than producing an unusable config', () => {
    const settings = loadAiSettings({ GENOFFICE_AI_PROVIDER: 'not-a-provider' })
    expect(settings.provider).toBe(defaultAiSettings().provider)
  })

  it('honours the active provider even when nothing else is configured for it', () => {
    expect(loadAiSettings({ GENOFFICE_AI_PROVIDER: 'anthropic' }).provider).toBe('anthropic')
  })

  it('falls back to the provider default model when only a key is given', () => {
    const settings = loadAiSettings({ GENOFFICE_AI_KEY_ANTHROPIC: SECRET_KEY })
    expect(settings.providers.anthropic?.model).toBe(defaultAiSettings().providers.anthropic.model)
  })

  it('keeps a base URL override for a configurable endpoint', () => {
    const settings = loadAiSettings({
      GENOFFICE_AI_KEY_CUSTOM: SECRET_KEY,
      GENOFFICE_AI_BASE_URL_CUSTOM: 'http://localhost:11434/v1',
      GENOFFICE_AI_MODEL_CUSTOM: 'local-model',
    })
    expect(settings.providers.custom).toMatchObject({
      apiKey: SECRET_KEY,
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-model',
    })
  })

  it('reads extra request headers for a provider', () => {
    const settings = loadAiSettings({
      GENOFFICE_AI_KEY_VLLM: SECRET_KEY,
      GENOFFICE_AI_HEADERS_VLLM: '{"X-Caller":"my-service"}',
    })
    expect(settings.providers.vllm?.headers).toEqual({ 'X-Caller': 'my-service' })
  })

  it('configures a provider given headers alone', () => {
    // Headers are a configuration signal like a key or a base URL: a provider
    // carrying only an attribution header must not be dropped from the merge.
    const settings = loadAiSettings({ GENOFFICE_AI_HEADERS_OPENROUTER: '{"X-Caller":"svc"}' })
    expect(settings.providers.openrouter?.headers).toEqual({ 'X-Caller': 'svc' })
  })

  it('leaves headers absent when the variable is unset or blank', () => {
    expect(loadAiSettings({ GENOFFICE_AI_KEY_VLLM: SECRET_KEY }).providers.vllm?.headers)
      .toBeUndefined()
    expect(
      loadAiSettings({ GENOFFICE_AI_KEY_VLLM: SECRET_KEY, GENOFFICE_AI_HEADERS_VLLM: '  ' })
        .providers.vllm?.headers,
    ).toBeUndefined()
  })

  it('refuses a malformed headers value instead of silently dropping it', () => {
    // A tracking header that quietly failed to load is worse than a service that
    // will not start: the requests still succeed, so nobody notices for months.
    const cases: Array<[string, string]> = [
      ['not json', 'must be a JSON object'],
      ['["X-Caller"]', 'must be a JSON object'],
      ['{"X-Caller":42}', 'must be a string'],
      ['{"X Caller":"v"}', 'is not a valid header name'],
    ]
    for (const [value, expected] of cases) {
      expect(() => loadAiSettings({ GENOFFICE_AI_HEADERS_VLLM: value }), value).toThrowError(
        new RegExp(`GENOFFICE_AI_HEADERS_VLLM.*${expected}|${expected}`),
      )
    }
  })

  it('produces plain defaults from an empty environment', () => {
    const settings = loadAiSettings({})
    expect(settings).toEqual(defaultAiSettings())
  })
})

describe('isProviderId', () => {
  it('accepts a known id and rejects everything else', () => {
    expect(isProviderId('anthropic')).toBe(true)
    expect(isProviderId('nope')).toBe(false)
    expect(isProviderId(undefined)).toBe(false)
  })
})

describe('toPublicSettings', () => {
  it('reports configuration as a boolean and carries no key material', () => {
    const view = toPublicSettings(settingsWithSecret())
    expect(view.version).toBe(1)
    expect(view.providers.anthropic).toEqual({
      providerId: 'anthropic',
      model: 'claude-test-1',
      credentialConfigured: true,
    })
    expect(JSON.stringify(view)).not.toContain(SECRET_KEY)
    // Not even the last four characters — the hint @genoffice/ai-electron keeps
    // is deliberately absent here, which is what makes the guarantee absolute.
    expect(JSON.stringify(view)).not.toContain(SECRET_KEY.slice(-4))
  })

  it('marks a provider with a model but no key as unconfigured', () => {
    const view = toPublicSettings(loadAiSettings({ GENOFFICE_AI_MODEL_ANTHROPIC: 'm' }))
    expect(view.providers.anthropic?.credentialConfigured).toBe(false)
  })
})

describe('resolveProvider', () => {
  it('resolves the active provider when it has a key and a model', () => {
    const result = resolveProvider(settingsWithSecret())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolved.provider).toBe('anthropic')
      expect(result.resolved.config.apiKey).toBe(SECRET_KEY)
    }
  })

  it('names the env var to set when no credential is configured', () => {
    // Regression guard: GENOFFICE_AI_PROVIDER on its own used to be dropped
    // (see the comment in loadAiSettings), so this reported GENSPARK — telling
    // the operator to set an env var for a provider they had not selected.
    const result = resolveProvider(loadAiSettings({ GENOFFICE_AI_PROVIDER: 'anthropic' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('GENOFFICE_AI_KEY_ANTHROPIC')
  })

  it('refuses a provider with a key but no model', () => {
    const settings = settingsWithSecret()
    settings.providers.anthropic.model = ''
    const result = resolveProvider(settings)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('No model')
  })
})

describe('createRedactor', () => {
  it('replaces every occurrence of every configured credential', () => {
    const redact = createRedactor(settingsWithSecret())
    expect(redact(`a ${SECRET_KEY} b ${SECRET_KEY}`)).toBe('a [redacted] b [redacted]')
  })

  it('passes text through untouched when nothing is configured', () => {
    const redact = createRedactor(defaultAiSettings())
    expect(redact('nothing to hide')).toBe('nothing to hide')
  })

  it('strips an auth-shaped custom header value but leaves attribution readable', () => {
    const settings = settingsWithSecret()
    settings.providers.anthropic.headers = {
      'X-Caller': 'my-service',
      'X-Gateway-Token': 'tok_0Vb3Qz9RmT2wKp7L',
    }
    const redact = createRedactor(settings)
    expect(redact('called by my-service with tok_0Vb3Qz9RmT2wKp7L')).toBe(
      'called by my-service with [redacted]',
    )
  })

  it('does not treat a short placeholder value as a secret to strip', () => {
    // An 8-character floor: redacting a 3-character value would mangle ordinary
    // prose, and no real credential is that short.
    const settings = defaultAiSettings()
    settings.providers.anthropic.apiKey = 'abc'
    const redact = createRedactor(settings)
    expect(redact('the abc of it')).toBe('the abc of it')
  })
})
