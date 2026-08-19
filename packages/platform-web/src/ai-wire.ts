/**
 * The HTTP contract between the browser and the AI BFF.
 *
 * Types only, and deliberately free of any DOM or Node reference: the BFF
 * imports this module (via the package's `./wire` export) to type its
 * responses, and the browser adapter imports it to type what it parses. One
 * declaration, so the two sides cannot drift.
 *
 * The defining property of `PublicAiSettings` is what it does *not* carry.
 * @samugen/ai-electron's `toPublicAiSettings` strips the key down to a
 * `••••1234` hint; this contract goes one step further and drops the hint too,
 * keeping only `credentialConfigured`. There is no settings UI in the browser
 * build to render a hint, and with the last four characters gone the guarantee
 * becomes absolute and testable: no fragment of any credential appears in any
 * response body.
 */
import type { AiProviderId, AiStreamRequest } from '@samugen/ai-provider'

/** Route prefix the browser calls, and the path the dev server proxies to the BFF. */
export const AI_BFF_BASE_PATH = '/v1/ai'

export const AI_BFF_ROUTES = {
  settings: `${AI_BFF_BASE_PATH}/settings`,
  stream: `${AI_BFF_BASE_PATH}/stream`,
  streamCancel: `${AI_BFF_BASE_PATH}/stream/cancel`,
  chat: `${AI_BFF_BASE_PATH}/chat`,
} as const

export interface PublicAiProviderSettings {
  providerId: AiProviderId
  model: string
  /** Only for providers whose endpoint is user-configurable; never carries credentials. */
  baseUrl?: string
  /** True when the server holds a usable credential for this provider. The credential itself is never sent. */
  credentialConfigured: boolean
}

export interface PublicAiSettings {
  version: 1
  /** The provider the server will use; the browser cannot choose one. */
  active: { providerId: AiProviderId; model: string }
  providers: Record<string, PublicAiProviderSettings>
}

/**
 * What the browser may ask for.
 *
 * `AiStreamRequest.settings` is deliberately omitted: it is the deprecated
 * renderer-supplied settings field, and accepting it from a browser would let a
 * page point the server's credentials at an endpoint of its choosing. The BFF
 * drops the field if it arrives anyway.
 */
export type AiStreamBody = Omit<AiStreamRequest, 'settings'>

export interface AiCancelBody {
  requestId: string
}

export interface AiChatBody {
  system: string
  user: string
}
