/**
 * Adapters over apps/docs' preload bridge (the `window.desktop` global).
 *
 * Same construction as pdf.ts: each factory takes the bridge as a parameter
 * instead of reading the global, so the adapters are unit-testable against a
 * fake and the renderer's coupling to the global is confined to one line of its
 * bootstrap.
 *
 * The bridge parameter types below are structural subsets of apps/docs'
 * `DesktopApi` (apps/docs/src/shared/ipc.ts). They are re-declared rather than
 * imported because packages must not depend on apps; `DesktopApi` satisfies each
 * of them structurally, so `createDocsAiPort(window.desktop)` type-checks.
 *
 * Only the *shared* ports live here. docs' own surfaces — the docx document
 * operations, the close-check handshake, the native-menu channel and PDF export
 * — are adapted in apps/docs, next to the port declarations they satisfy, which
 * is the same division pdf uses for its Save As handshake.
 *
 * `AttachmentsPort` is not here either, and for the opposite reason: docs, slides and
 * sheets all expose the same six path-based attachment methods, so that adapter is
 * app-independent and lives in attachments.ts.
 */
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@samugen/ai-provider'
import type { Lang } from '@samugen/i18n'
import type {
  AiPort,
  ImageSearchResult,
  LanguagePort,
  SearchPort,
  WebSearchResult,
  WindowPort,
} from '@samugen/platform'

/** The language members of DesktopApi. Its own union is a subset of `Lang`, so it satisfies this. */
export interface DocsLanguageBridge {
  getLanguage(): Promise<Lang>
  onLanguageChanged(handler: (lang: Lang) => void): () => void
  setLanguage(lang: Lang): Promise<void>
}

/** The AI streaming members of DesktopApi. Names and signatures already match AiPort exactly. */
export interface DocsAiBridge {
  getAiSettings(): Promise<AiSettings>
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
}

/** The search members of DesktopApi. */
export interface DocsSearchBridge {
  webSearch(query: string, maxResults?: number): Promise<WebSearchResult>
  imageSearch(query: string, maxResults?: number): Promise<ImageSearchResult>
  fetchImage(url: string): Promise<{ base64: string; mime: string } | null>
}

/** The tab members of DesktopApi. Note the `Docs` infix the port drops. */
export interface DocsTabsBridge {
  openNewTab(openPath?: string | null): Promise<void>
  listDocsTabs(): Promise<Array<{ id: string; title: string; focused: boolean }>>
  focusDocsTab(id: string): Promise<void>
}

/** The close-guard reply members of DesktopApi. Names already match the port. */
export interface DocsCloseSaveBridge {
  onCloseSaveRequest(handler: () => void): () => void
  reportCloseSaveResult(ok: boolean): void
}

/** The tab slice of WindowPort — docs' preload forwards all three channels. */
export type DocsTabsSlice = Pick<WindowPort, 'openNewTab' | 'listTabs' | 'focusTab'>

/**
 * The close-guard reply slice of WindowPort.
 *
 * Deliberately not `setDirty`: docs' preload exposes no such channel, because
 * its host pulls the dirty state at close time instead of being pushed it. That
 * half of the conversation is a docs-specific port — see
 * apps/docs/src/renderer/platform.ts.
 */
export type DocsCloseSaveSlice = Pick<WindowPort, 'onCloseSaveRequest' | 'reportCloseSaveResult'>

/** LanguagePort over the docs bridge. */
export function createDocsLanguagePort(bridge: DocsLanguageBridge): LanguagePort {
  return {
    getLanguage: () => bridge.getLanguage(),
    onLanguageChanged: (handler) => bridge.onLanguageChanged(handler),
    setLanguage: (lang) => bridge.setLanguage(lang),
  }
}

/**
 * AiPort over the docs bridge.
 *
 * `AiSettingsPort` and `AiChatPort` are not built here even though docs' preload
 * forwards 'ai:set-settings' and 'ai:chat': the docs renderer has no call site
 * for either (settings are edited in the shell), and this seam claims only what
 * is used.
 */
export function createDocsAiPort(bridge: DocsAiBridge): AiPort {
  return {
    getAiSettings: () => bridge.getAiSettings(),
    aiStream: (request) => bridge.aiStream(request),
    aiStreamCancel: (requestId) => bridge.aiStreamCancel(requestId),
    onAiStream: (handler) => bridge.onAiStream(handler),
  }
}

/** SearchPort over the docs bridge. */
export function createDocsSearchPort(bridge: DocsSearchBridge): SearchPort {
  return {
    webSearch: (query, maxResults) => bridge.webSearch(query, maxResults),
    imageSearch: (query, maxResults) => bridge.imageSearch(query, maxResults),
    fetchImage: (url) => bridge.fetchImage(url),
  }
}

/** The tab slice of WindowPort over the docs bridge; drops the bridge's `Docs` infix. */
export function createDocsTabsPort(bridge: DocsTabsBridge): DocsTabsSlice {
  return {
    openNewTab: (openRef) => bridge.openNewTab(openRef),
    listTabs: () => bridge.listDocsTabs(),
    focusTab: (id) => bridge.focusDocsTab(id),
  }
}

/** The close-guard reply slice of WindowPort over the docs bridge. */
export function createDocsCloseSavePort(bridge: DocsCloseSaveBridge): DocsCloseSaveSlice {
  return {
    onCloseSaveRequest: (handler) => bridge.onCloseSaveRequest(handler),
    reportCloseSaveResult: (ok) => bridge.reportCloseSaveResult(ok),
  }
}
