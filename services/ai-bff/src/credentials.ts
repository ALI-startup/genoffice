/** Where the keys live: the server's environment, and nowhere else. */
import {
  AI_PROVIDERS,
  defaultAiSettings,
  resolveAiSettings,
  type AiProviderConfig,
  type AiProviderId,
  type AiSettings,
} from '@samugen/ai-provider'
import type { PublicAiSettings } from '@samugen/platform-web/wire'

export type Env = Record<string, string | undefined>

const envSuffix = (provider: AiProviderId) => provider.toUpperCase().replace(/-/g, '_')

/** Read the server's provider configuration out of the environment. */
export function loadAiSettings(env: Env = process.env): AiSettings {
  const providers: Partial<Record<AiProviderId, AiProviderConfig>> = {}
  for (const meta of AI_PROVIDERS) {
    const suffix = envSuffix(meta.id)
    const apiKey = env[`SAMUGEN_AI_KEY_${suffix}`]?.trim()
    const model = env[`SAMUGEN_AI_MODEL_${suffix}`]?.trim()
    const baseUrl = env[`SAMUGEN_AI_BASE_URL_${suffix}`]?.trim()
    const headersVar = `SAMUGEN_AI_HEADERS_${suffix}`
    const headers = parseHeaders(env[headersVar], headersVar)
    if (!apiKey && !model && !baseUrl && !headers) continue
    providers[meta.id] = {
      apiKey: apiKey ?? '',
      model: model || meta.defaultModel,
      ...(baseUrl ? { baseUrl } : {}),
      ...(headers ? { headers } : {}),
    }
  }
  const merged = resolveAiSettings(
    Object.keys(providers).length > 0 ? { providers: providers as AiSettings['providers'] } : {},
    defaultAiSettings(),
  )
  // The active provider is applied *after* the merge rather than inside it.
  const active = env.SAMUGEN_AI_PROVIDER?.trim()
  return isProviderId(active) ? { ...merged, provider: active } : merged
}

/** Parse a `SAMUGEN_AI_HEADERS_*` value into request headers. */
function parseHeaders(
  raw: string | undefined,
  envName: string,
): Record<string, string> | undefined {
  const text = raw?.trim()
  if (!text) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${envName} must be a JSON object, e.g. {"X-Caller":"my-service"}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object, e.g. {"X-Caller":"my-service"}`)
  }

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    const header = name.trim()
    if (!header) continue
    if (typeof value !== 'string') {
      throw new Error(`${envName}: header "${header}" must be a string`)
    }
    // fetch() throws a bare "Invalid header" on a malformed name, far from the
    // env var that caused it, so the field-name grammar is checked up front.
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) {
      throw new Error(`${envName}: "${header}" is not a valid header name`)
    }
    headers[header] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function isProviderId(value: string | undefined): value is AiProviderId {
  return AI_PROVIDERS.some((meta) => meta.id === value)
}

/** The only view of the settings the browser is allowed to see. */
export function toPublicSettings(settings: AiSettings): PublicAiSettings {
  const providers: PublicAiSettings['providers'] = {}
  for (const meta of AI_PROVIDERS) {
    const config = settings.providers[meta.id]
    if (!config) continue
    providers[meta.id] = {
      providerId: meta.id,
      model: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      credentialConfigured: Boolean(config.apiKey),
    }
  }
  const activeConfig = settings.providers[settings.provider]
  return {
    version: 1,
    active: {
      providerId: settings.provider,
      model: activeConfig?.model ?? '',
    },
    providers,
  }
}

export interface ResolvedProvider {
  provider: AiProviderId
  config: AiProviderConfig
}

/** Pick the provider for a request. */
export function resolveProvider(
  settings: AiSettings,
): { ok: true; resolved: ResolvedProvider } | { ok: false; error: string } {
  const provider = settings.provider
  const config = settings.providers[provider]
  if (!config?.apiKey) {
    return {
      ok: false,
      error:
        `No credential is configured on the server for "${provider}". Set ` +
        `SAMUGEN_AI_KEY_${envSuffix(provider)} and restart the BFF.`,
    }
  }
  if (!config.model) {
    return { ok: false, error: `No model is configured on the server for "${provider}".` }
  }
  return { ok: true, resolved: { provider, config } }
}
