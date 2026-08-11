/**
 * Adapters over apps/pdf's preload bridge (the `window.pdfApi` global).
 *
 * Each factory takes the bridge as a parameter instead of reading the global,
 * so the adapters are unit-testable against a fake and the renderer's coupling
 * to the global is confined to one line of its bootstrap.
 *
 * The bridge parameter types below are structural subsets of apps/pdf's
 * `PdfApi` (apps/pdf/src/shared/ipc.ts). They are re-declared rather than
 * imported because packages must not depend on apps; `PdfApi` satisfies each
 * of them structurally, so `createPdfAiPort(window.pdfApi)` type-checks.
 */
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import type { AiPort, LanguagePort, WindowPort } from '@genoffice/platform'

/** The AI members of PdfApi. Names and signatures already match AiPort exactly. */
export interface PdfAiBridge {
  getAiSettings(): Promise<AiSettings>
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

/** The language members of PdfApi. */
export interface PdfLanguageBridge {
  getLanguage(): Promise<Lang>
  onLanguageChanged(handler: (lang: Lang) => void): () => void
}

/** The window-integration members of PdfApi. Note `sendCloseSaveResult`, which the port calls `reportCloseSaveResult`. */
export interface PdfWindowBridge {
  setDirty(dirty: boolean): void
  onCloseSaveRequest(handler: () => void): () => void
  sendCloseSaveResult(ok: boolean): void
}

/**
 * The slice of WindowPort a pdf renderer can be given.
 *
 * pdf's preload forwards no tab channel ('win:new' / 'win:list' / 'win:focus'),
 * and standalone pdf has no shell tab strip at all, so it must not claim the
 * whole port — see the availability table in @genoffice/platform's window port.
 */
export type PdfWindowSlice = Pick<
  WindowPort,
  'setDirty' | 'onCloseSaveRequest' | 'reportCloseSaveResult'
>

/**
 * AiPort over the pdf bridge.
 *
 * Only `AiPort` — not AiSettingsPort / AiChatPort / GensparkPort. Those
 * channels have no ipcMain handler when pdf runs standalone
 * (apps/pdf/src/main/pdf-main.ts:549 registers only `registerPdfIpc()`), so
 * claiming them here would be a stub by another name.
 */
export function createPdfAiPort(bridge: PdfAiBridge): AiPort {
  return {
    getAiSettings: () => bridge.getAiSettings(),
    aiStream: (request) => bridge.aiStream(request),
    aiStreamCancel: (requestId) => bridge.aiStreamCancel(requestId),
    onAiStream: (handler) => bridge.onAiStream(handler),
  }
}

/** LanguagePort over the pdf bridge. */
export function createPdfLanguagePort(bridge: PdfLanguageBridge): LanguagePort {
  return {
    getLanguage: () => bridge.getLanguage(),
    onLanguageChanged: (handler) => bridge.onLanguageChanged(handler),
  }
}

/** The dirty-state + close-guard slice of WindowPort over the pdf bridge. */
export function createPdfWindowPort(bridge: PdfWindowBridge): PdfWindowSlice {
  return {
    setDirty: (dirty) => bridge.setDirty(dirty),
    onCloseSaveRequest: (handler) => bridge.onCloseSaveRequest(handler),
    // The rename lives here: pdf's bridge says `send`, the port says `report`.
    reportCloseSaveResult: (ok) => bridge.sendCloseSaveResult(ok),
  }
}
