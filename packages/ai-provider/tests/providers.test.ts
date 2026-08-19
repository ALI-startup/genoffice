import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  defaultAiSettings,
  resolveAiSettings,
} from '../src/providers'

describe('defaultAiSettings', () => {
  it('gives every provider its default model and an empty key by default', () => {
    const settings = defaultAiSettings()
    // Named explicitly, not taken from the head of the list, so reordering the
    // settings screen cannot move the default out from under a fresh install.
    expect(settings.provider).toBe(DEFAULT_AI_PROVIDER)
    expect(DEFAULT_AI_PROVIDER).toBe('vllm')
    for (const meta of AI_PROVIDERS) {
      expect(settings.providers[meta.id].apiKey).toBe('')
      expect(settings.providers[meta.id].model).toBe(meta.defaultModel)
    }
    expect(settings.providers.custom.baseUrl).toBe('')
    expect(settings.providers.anthropic.baseUrl).toBeUndefined()
  })

  it('applies caller-supplied default keys only to the listed providers', () => {
    const settings = defaultAiSettings({ anthropic: 'sk-ant-preset' })
    expect(settings.providers.anthropic.apiKey).toBe('sk-ant-preset')
    expect(settings.providers.gemini.apiKey).toBe('')
  })
})

describe('provider catalog', () => {
  it('includes cloud, OpenRouter, and local OpenAI-compatible presets', () => {
    expect(AI_PROVIDERS.map((meta) => meta.id)).toEqual(
      expect.arrayContaining([
        'openrouter',
        'mistral',
        'groq',
        'together',
        'fireworks',
        'cerebras',
        'xai',
        'nvidia',
        'ollama',
        'lmstudio',
        'vllm',
        'llamacpp',
      ]),
    )
    expect(AI_PROVIDERS.find((meta) => meta.id === 'openrouter')).toMatchObject({
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      imageProtocol: 'openai-images',
    })
    expect(AI_PROVIDERS.find((meta) => meta.id === 'ollama')).toMatchObject({
      defaultBaseUrl: 'http://localhost:11434/v1',
      endpointKind: 'local',
    })
  })

  it('opens vLLM on the gateway-served Qwen model', () => {
    // The default provider's model has to be one the picker actually offers,
    // otherwise the settings screen boots with a selection it cannot show.
    const vllm = AI_PROVIDERS.find((meta) => meta.id === DEFAULT_AI_PROVIDER)
    expect(vllm).toMatchObject({ defaultModel: 'qwen36-35b', endpointKind: 'local' })
    expect(vllm!.models).toContain(vllm!.defaultModel)
    expect(defaultAiSettings().providers.vllm.model).toBe('qwen36-35b')
  })
})

describe('resolveAiSettings', () => {
  it('returns fresh defaults when nothing is stored', () => {
    const defaults = defaultAiSettings({ anthropic: 'sk-ant-preset' })
    expect(resolveAiSettings({}, defaults)).toEqual(defaults)
  })

  it('migrates the pre-provider single-endpoint shape into the custom provider', () => {
    const defaults = defaultAiSettings()
    const resolved = resolveAiSettings(
      { apiKey: 'legacy-key', model: 'legacy-model', baseUrl: 'https://legacy.example.com/v1' },
      defaults,
    )
    expect(resolved.providers.custom).toEqual({
      apiKey: 'legacy-key',
      model: 'legacy-model',
      baseUrl: 'https://legacy.example.com/v1',
    })
    // untouched providers keep their defaults
    expect(resolved.providers.anthropic).toEqual(defaults.providers.anthropic)
  })

  it('defaults the legacy base URL to the OpenAI endpoint when omitted', () => {
    const resolved = resolveAiSettings({ apiKey: 'legacy-key' }, defaultAiSettings())
    expect(resolved.providers.custom.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('merges stored multi-provider settings over the defaults, provider by provider', () => {
    const defaults = defaultAiSettings({ anthropic: 'preset-key' })
    const resolved = resolveAiSettings(
      {
        provider: 'gemini',
        providers: {
          gemini: { apiKey: 'stored-gemini-key', model: 'gemini-2.5-pro' },
        } as never,
      },
      defaults,
    )
    expect(resolved.provider).toBe('gemini')
    expect(resolved.providers.gemini).toEqual({
      apiKey: 'stored-gemini-key',
      model: 'gemini-2.5-pro',
    })
    // provider not mentioned in stored.providers keeps the computed default
    expect(resolved.providers.anthropic.apiKey).toBe('preset-key')
  })
})
