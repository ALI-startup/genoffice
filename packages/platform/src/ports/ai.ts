/**
 * The AI capability: reading the provider settings, and the streaming call.
 *
 * Every member is required. There is one port rather than several because there is
 * one way to reach a provider — `services/ai-bff` on this origin, which holds the
 * credentials — so a host that can make an AI call can make all four of these, and
 * one that cannot backs none of them.
 *
 * Settings are read-only here on purpose: the BFF loads its credentials from its own
 * environment and exposes no write route, so nothing in the page can change them.
 * That is why there is no `setAiSettings` — a port for it would be a capability no
 * host can honour, and the shell's settings screen renders the masked summary this
 * port returns rather than a form.
 */
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@samugen/ai-provider'

/** Reading AI settings plus the streaming call. */
export interface AiPort {
  getAiSettings(): Promise<AiSettings>
  /** Start a streaming call; deltas arrive via onAiStream with the same requestId. */
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  /** Subscribe to AI stream chunks; returns an unsubscribe. */
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}
