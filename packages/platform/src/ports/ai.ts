/** The AI capability: reading the provider settings, and the streaming call. */
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
