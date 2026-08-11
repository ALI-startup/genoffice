/**
 * Where the keys live: the server's environment, and nowhere else.
 *
 * Electron keeps credentials in an OS-encrypted store next to the app
 * (@genoffice/ai-electron). A browser has no equivalent — anything the page can
 * read, an extension or an XSS can read — so on the web the credential must
 * never leave the server. This module is the only place in the web stack that
 * ever holds one.
 *
 * The env shape mirrors the provider ids in @genoffice/ai-provider:
 *
 *   GENOFFICE_AI_PROVIDER              active provider id (default: whatever
 *                                      @genoffice/ai-provider's
 *                                      `defaultAiSettings` selects)
 *   GENOFFICE_AI_KEY_<PROVIDER>        credential, e.g. GENOFFICE_AI_KEY_ANTHROPIC
 *   GENOFFICE_AI_MODEL_<PROVIDER>      model override
 *   GENOFFICE_AI_BASE_URL_<PROVIDER>   endpoint override (custom / local providers)
 *   GENOFFICE_AI_HEADERS_<PROVIDER>    extra request headers, as a JSON object
 *                                      e.g. {"X-Caller":"my-service"}
 *
 * `<PROVIDER>` is the provider id upper-cased with `-` → `_`.
 *
 * Extra headers exist for gateways that require caller attribution for billing
 * or tracking. They are merged *under* the transport's own headers in
 * @genoffice/ai-provider, so they can add to a request but never rewrite its
 * credential, content type or protocol version. A malformed value throws rather
 * than being skipped: a tracking header that silently failed to load is worse
 * than a service that refuses to start.
 *
 * The resulting `AiSettings` is built with @genoffice/ai-provider's own
 * `defaultAiSettings` + `resolveAiSettings`, so model defaults and the legacy
 * migration behave exactly as they do in the Electron main process.
 */
import {
  AI_PROVIDERS,
  defaultAiSettings,
  resolveAiSettings,
  type AiProviderConfig,
  type AiProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import type { PublicAiSettings } from '@genoffice/platform-web/wire'

export type Env = Record<string, string | undefined>

const envSuffix = (provider: AiProviderId) => provider.toUpperCase().replace(/-/g, '_')

/** Read the server's provider configuration out of the environment. */
export function loadAiSettings(env: Env = process.env): AiSettings {
  const providers: Partial<Record<AiProviderId, AiProviderConfig>> = {}
  for (const meta of AI_PROVIDERS) {
    const suffix = envSuffix(meta.id)
    const apiKey = env[`GENOFFICE_AI_KEY_${suffix}`]?.trim()
    const model = env[`GENOFFICE_AI_MODEL_${suffix}`]?.trim()
    const baseUrl = env[`GENOFFICE_AI_BASE_URL_${suffix}`]?.trim()
    const headersVar = `GENOFFICE_AI_HEADERS_${suffix}`
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
  // `resolveAiSettings` ignores every other field when `providers` is absent
  // (that branch exists for the legacy single-endpoint migration), so passing
  // `provider` in alongside would silently drop it whenever the operator set
  // GENOFFICE_AI_PROVIDER without also setting a key, model or base URL for it
  // — and `resolveProvider` would then name the wrong env var in its error.
  const active = env.GENOFFICE_AI_PROVIDER?.trim()
  return isProviderId(active) ? { ...merged, provider: active } : merged
}

/**
 * Parse a `GENOFFICE_AI_HEADERS_*` value into request headers.
 *
 * JSON rather than a `Name: value, Name: value` list, because header values
 * legitimately contain both commas and colons and no delimiter convention
 * survives that without an escaping scheme nobody wants to write in a .env file.
 *
 * Every rejection throws with the offending variable named. The caller runs at
 * boot, so a typo surfaces as a startup failure the operator reads once, rather
 * than as a header that is quietly missing from every request thereafter.
 */
function parseHeaders(raw: string | undefined, envName: string): Record<string, string> | undefined {
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

/**
 * The only view of the settings the browser is allowed to see.
 *
 * @genoffice/ai-electron's `toPublicAiSettings` keeps a `••••1234` hint of the
 * credential for its settings UI. This one drops the hint: the browser build
 * has no settings UI to render it, and without it "no credential material
 * appears in any response body" becomes an absolute, testable property rather
 * than one with a four-character exception. `credentialConfigured` carries the
 * only fact a client actually needs.
 */
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

/**
 * Pick the provider for a request. The client names a task, never a provider —
 * so a page cannot aim the server's credentials at an endpoint it chose.
 *
 * Returns a reason string instead of throwing when nothing is usable, so the
 * caller can report it as a normal stream error chunk.
 */
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
        `GENOFFICE_AI_KEY_${envSuffix(provider)} and restart the BFF.`,
    }
  }
  if (!config.model) {
    return { ok: false, error: `No model is configured on the server for "${provider}".` }
  }
  return { ok: true, resolved: { provider, config } }
}
