/** The HTTP contract between the browser and the AI BFF. */
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

/** What the browser may ask for. */
export type AiStreamBody = Omit<AiStreamRequest, 'settings'>

export interface AiCancelBody {
  requestId: string
}

export interface AiChatBody {
  system: string
  user: string
}
