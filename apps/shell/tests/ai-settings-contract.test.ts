import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDER_DEFINITIONS,
  AI_SETTINGS_CHANNELS,
  DEFAULT_AI_PROVIDER,
  type SaveAiProviderInput,
} from '../src/shared/ai-settings-api'

describe('AI settings public contract', () => {
  it('keeps provider identifiers unique and exposes the required local presets', () => {
    const ids = AI_PROVIDER_DEFINITIONS.map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      expect.arrayContaining(['openrouter', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'custom']),
    )
    expect(
      AI_PROVIDER_DEFINITIONS.find((provider) => provider.id === 'ollama')?.defaultBaseUrl,
    ).toBe('http://localhost:11434/v1')
  })

  it('marks image-capable providers explicitly for the image selector', () => {
    const imageProviders = AI_PROVIDER_DEFINITIONS.filter((provider) => provider.supportsImages)
    expect(imageProviders.map((provider) => provider.id)).toEqual(
      expect.arrayContaining([
        'openai',
        'gemini',
        'openrouter',
        'together',
        'runware',
        'replicate',
        'fal',
        'stability',
      ]),
    )
  })

  it('ships a Mistral model selector and hides fixed cloud endpoints', () => {
    const mistral = AI_PROVIDER_DEFINITIONS.find((provider) => provider.id === 'mistral')
    expect(mistral?.models).toEqual(expect.arrayContaining(['mistral-large-latest']))
    expect(mistral?.supportsModelDiscovery).toBe(true)
    expect(mistral?.needsBaseUrl).toBe(false)
  })

  it('keeps channel names namespaced to the settings surface', () => {
    expect(
      Object.values(AI_SETTINGS_CHANNELS).every((channel) => channel.startsWith('ai-settings:')),
    ).toBe(true)
  })

  it('supports separate model discovery and selected-model probes', () => {
    const discover: SaveAiProviderInput = {
      providerId: 'runware',
      capability: 'image',
      operation: 'discover',
      model: 'runware:100@1',
    }
    const test: SaveAiProviderInput = { ...discover, operation: 'test', model: 'custom:1@1' }
    expect(discover.operation).toBe('discover')
    expect(test.operation).toBe('test')
  })
})

describe('the default provider a screen opens on', () => {
  it('is the one named in the provider package, not the head of the display list', () => {
    // The list is display order; the default is a separate decision.
    expect(AI_PROVIDER_DEFINITIONS[0]?.id).not.toBe(DEFAULT_AI_PROVIDER)
    expect(AI_PROVIDER_DEFINITIONS.some((d) => d.id === DEFAULT_AI_PROVIDER)).toBe(true)
  })

  it('carries that provider’s own default model, which is not its first', () => {
    const definition = AI_PROVIDER_DEFINITIONS.find((d) => d.id === DEFAULT_AI_PROVIDER)
    expect(definition?.defaultModel).toBeTruthy()
    expect(definition?.models).toContain(definition?.defaultModel)
    expect(definition?.defaultModel).not.toBe(definition?.models[0])
  })
})
