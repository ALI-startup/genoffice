import type { AiProviderId, AiProviderMeta, AiSettings, LegacyAiSettings } from './types'

/**
 * User-facing presets. `capabilities` is a provider-level baseline only; model
 * pickers must prefer the live catalog's model-level capabilities when available.
 */
export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    models: [
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
    ],
    defaultModel: 'claude-opus-4-7',
    keyPlaceholder: 'sk-ant-api03-...',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/v1/models',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    keyPlaceholder: 'AIza...',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    endpointKind: 'cloud',
    capabilities: ['chat', 'image-generation'],
    imageModels: ['gemini-2.5-flash-image', 'imagen-4.0-generate-001'],
    imageProtocol: 'gemini',
    modelListPath: '/models',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-v4-flash',
    keyPlaceholder: 'sk-...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-4.1-mini',
    keyPlaceholder: 'sk-...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    endpointKind: 'cloud',
    capabilities: ['chat', 'image-generation', 'image-editing'],
    imageModels: ['gpt-image-1', 'dall-e-3'],
    imageProtocol: 'openai-images',
    modelListPath: '/models',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    models: [
      'google/gemma-3-27b-it:free',
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-4.1-mini',
      'google/gemini-2.5-flash',
    ],
    defaultModel: 'google/gemma-3-27b-it:free',
    keyPlaceholder: 'sk-or-v1-...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    endpointKind: 'cloud',
    capabilities: ['chat', 'image-generation'],
    imageModels: [
      'google/gemini-2.5-flash-image',
      'black-forest-labs/flux.1-kontext-pro',
      'openai/gpt-image-1',
    ],
    imageProtocol: 'openai-images',
    modelListPath: '/models',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    defaultModel: 'mistral-large-latest',
    keyPlaceholder: 'API key',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'groq',
    label: 'Groq',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    defaultModel: 'llama-3.3-70b-versatile',
    keyPlaceholder: 'gsk_...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'together',
    label: 'Together AI',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyPlaceholder: 'API key',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    endpointKind: 'cloud',
    capabilities: ['chat', 'image-generation'],
    imageModels: ['black-forest-labs/FLUX.1-schnell-Free', 'black-forest-labs/FLUX.1.1-pro'],
    imageProtocol: 'openai-images',
    modelListPath: '/models',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    models: ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
    defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    keyPlaceholder: 'API key',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    models: ['llama-3.3-70b'],
    defaultModel: 'llama-3.3-70b',
    keyPlaceholder: 'API key',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'xai',
    label: 'xAI',
    models: ['grok-3-mini', 'grok-3'],
    defaultModel: 'grok-3-mini',
    keyPlaceholder: 'xai-...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1',
    endpointKind: 'cloud',
    capabilities: ['chat', 'image-generation'],
    imageModels: ['grok-2-image-1212'],
    imageProtocol: 'openai-images',
    modelListPath: '/models',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    models: ['meta/llama-3.1-70b-instruct'],
    defaultModel: 'meta/llama-3.1-70b-instruct',
    keyPlaceholder: 'nvapi-...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    endpointKind: 'cloud',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    models: ['llama3.2'],
    defaultModel: 'llama3.2',
    keyPlaceholder: 'Not required',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    endpointKind: 'local',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    models: ['local-model'],
    defaultModel: 'local-model',
    keyPlaceholder: 'Not required',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:1234/v1',
    endpointKind: 'local',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    models: ['qwen38-27b', 'qwen36-35b'],
    defaultModel: 'qwen36-35b',
    keyPlaceholder: 'Not required',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:8000/v1',
    endpointKind: 'local',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    models: ['local-model'],
    defaultModel: 'local-model',
    keyPlaceholder: 'Not required',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:8080/v1',
    endpointKind: 'local',
    capabilities: ['chat'],
    imageProtocol: 'none',
    modelListPath: '/models',
  },
  {
    id: 'runware',
    label: 'Runware',
    models: ['xai:grok-imagine@image-quality'],
    imageModels: ['xai:grok-imagine@image-quality', 'runware:100@1', 'civitai:133005@782002'],
    defaultModel: 'xai:grok-imagine@image-quality',
    keyPlaceholder: 'Runware API key',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.runware.ai/v1',
    endpointKind: 'cloud',
    capabilities: ['image-generation', 'image-editing'],
    imageProtocol: 'runware',
  },
  {
    id: 'replicate',
    label: 'Replicate',
    models: ['black-forest-labs/flux-1.1-pro', 'black-forest-labs/flux-schnell', 'google/imagen-4'],
    imageModels: [
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'google/imagen-4',
    ],
    defaultModel: 'black-forest-labs/flux-1.1-pro',
    keyPlaceholder: 'r8_...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.replicate.com/v1',
    endpointKind: 'cloud',
    capabilities: ['image-generation', 'image-editing'],
    imageProtocol: 'replicate',
    modelListPath: '/models',
  },
  {
    id: 'fal',
    label: 'fal',
    models: ['fal-ai/nano-banana-2', 'fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1'],
    imageModels: ['fal-ai/nano-banana-2', 'fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1'],
    defaultModel: 'fal-ai/nano-banana-2',
    keyPlaceholder: 'FAL_KEY',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://queue.fal.run',
    endpointKind: 'cloud',
    capabilities: ['image-generation', 'image-editing'],
    imageProtocol: 'fal',
  },
  {
    id: 'stability',
    label: 'Stability AI',
    models: ['stable-image-ultra', 'stable-image-core', 'sd3.5-large'],
    imageModels: ['stable-image-ultra', 'stable-image-core', 'sd3.5-large'],
    defaultModel: 'stable-image-core',
    keyPlaceholder: 'sk-...',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.stability.ai/v2beta',
    endpointKind: 'cloud',
    capabilities: ['image-generation', 'image-editing'],
    imageProtocol: 'stability',
  },
  {
    id: 'custom',
    label: 'Custom',
    models: [],
    defaultModel: '',
    keyPlaceholder: 'API Key',
    needsBaseUrl: true,
    protocol: 'openai-compatible',
    endpointKind: 'custom',
    capabilities: ['chat'],
    imageProtocol: 'openai-images',
    modelListPath: '/models',
  },
]

/**
 * The provider a fresh install opens on. Named explicitly rather than taken
 * from the head of `AI_PROVIDERS`, so the settings screen's display order and
 * the default are free to change independently.
 */
export const DEFAULT_AI_PROVIDER: AiProviderId = 'vllm'

export const AI_PROVIDER_BY_ID = Object.fromEntries(
  AI_PROVIDERS.map((provider) => [provider.id, provider]),
) as Readonly<Record<AiProviderId, AiProviderMeta>>

/**
 * Fresh settings with every provider's default model and an empty key,
 * except providers listed in `defaultApiKeys` (e.g. an app-specific
 * preconfigured Anthropic key). Callers own that policy; this package
 * has no hardcoded keys.
 */
export function defaultAiSettings(
  defaultApiKeys?: Partial<Record<AiProviderId, string>>,
): AiSettings {
  const providers = {} as AiSettings['providers']
  for (const meta of AI_PROVIDERS) {
    providers[meta.id] = {
      apiKey: defaultApiKeys?.[meta.id] ?? '',
      model: meta.defaultModel,
      // Built-in transports resolve their endpoint from provider metadata. Keep
      // the legacy shape (undefined for built-ins) so existing persisted settings
      // and callers continue to round-trip unchanged.
      baseUrl: meta.needsBaseUrl ? '' : undefined,
    }
  }
  // Every provider still needs either a key or a reachable server before it
  // answers, so this only picks the row the settings screen opens on.
  return { provider: DEFAULT_AI_PROVIDER, providers }
}

/**
 * Merge on-disk settings over freshly computed defaults, migrating the
 * pre-provider shape (a single OpenAI-compatible endpoint) into the
 * "custom" provider slot. `stored` is whatever the caller read from its
 * settings file (already JSON-parsed); this function does no file I/O.
 */
export function resolveAiSettings(
  stored: Partial<AiSettings> & LegacyAiSettings,
  defaults: AiSettings,
): AiSettings {
  if (!stored.providers) {
    if (stored.apiKey) {
      defaults.providers.custom = {
        apiKey: stored.apiKey,
        model: stored.model ?? '',
        baseUrl: stored.baseUrl ?? 'https://api.openai.com/v1',
      }
    }
    return defaults
  }
  return {
    provider: stored.provider ?? defaults.provider,
    providers: { ...defaults.providers, ...stored.providers },
  }
}
