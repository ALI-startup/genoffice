/**
 * AI capabilities, split into three ports along host-capability lines.
 *
 * Every member of every port is required. The split exists because the AI
 * surface is *not* one capability: the channels behind it are registered by
 * different hosts, so a single fat `AiPort` could only be honored by stubbing
 * members — the exact failure the package rule forbids ("a host that cannot
 * back a capability must not claim it").
 *
 * | port       | method         | pdf | docs | slides | sheets |
 * | ---------- | -------------- | --- | ---- | ------ | ------ |
 * | ai         | getAiSettings  | yes | yes  | yes    | yes    |
 * | ai         | aiStream       | yes | yes  | yes    | yes    |
 * | ai         | aiStreamCancel | yes | yes  | yes    | yes    |
 * | ai         | onAiStream     | yes | yes  | yes    | yes    |
 * | aiSettings | setAiSettings  | no  | yes  | yes    | yes    |
 * | aiChat     | aiChat         | no  | yes  | no     | yes    |
 *
 * The pdf column is a genuine host limitation, not just a preload omission.
 * `startPdfStandalone()` (apps/pdf/src/main/pdf-main.ts:549) calls only
 * `registerPdfIpc()`; the ai:* ipcMain handlers live in docs-main's
 * `registerAiIpc` and are registered by the shell (apps/shell/src/main/index.ts)
 * — so they exist only while pdf runs as a WebContentsView tab inside the shell.
 * Forwarding 'ai:set-settings' or 'ai:chat' from pdf's preload would therefore
 * not be enough; in standalone mode there is no handler on the other end.
 *
 * Consequence, and the reason `ai` is a separate port rather than a merged one:
 * a shell-hosted pdf backs `ai` in full and neither of the other two, so it
 * installs `ai` alone. Standalone pdf backs no AI channel at all (registerAiIpc
 * covers 'ai:get-settings' and 'ai:stream' too) and must install none of the
 * three — which is a pre-existing product gap in standalone mode, surfaced by
 * this modelling rather than caused by it.
 *
 * `SearchPort` is deliberately *not* split the same way: 'ai:image-search' is
 * registered in apps/sheets/src/main/sheets-main.ts, so sheets' missing
 * `imageSearch` really is only a preload omission and the host can back the
 * whole port.
 *
 * The signatures are identical wherever a method exists (docs and sheets
 * declare them as methods, slides as arrow-function properties — same type).
 */
import type {
  AiChatRequest,
  AiChatResponse,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
} from '@genoffice/ai-provider'

/** Reading AI settings plus the streaming call — every AI-capable host backs all four. */
export interface AiPort {
  getAiSettings(): Promise<AiSettings>
  /** Start a streaming call; deltas arrive via onAiStream with the same requestId. */
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  /** Subscribe to AI stream chunks; returns an unsubscribe. */
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

/** Writing AI settings; only hosts with a settings UI behind them back this. */
export interface AiSettingsPort {
  setAiSettings(settings: AiSettings): Promise<void>
}

/** One-shot (non-streaming) completion, used by the docs/sheets inline-AI surfaces. */
export interface AiChatPort {
  aiChat(request: AiChatRequest): Promise<AiChatResponse>
}
