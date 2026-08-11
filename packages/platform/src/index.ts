/**
 * Platform abstraction seam.
 *
 * `PlatformPorts` is the catalogue of capability ports the apps share. It has
 * exactly two implementations in mind — Electron (preload bridges) and Web
 * (HTTP/browser APIs) — and neither lives here: this package is interfaces
 * plus a slot factory, with no runtime dependency on Electron.
 *
 * Design rule: nothing here is optional. Optional members are how the
 * hand-written web shims drift — an unimplemented method returns `undefined`
 * at runtime instead of failing to compile. An app declares the capabilities
 * it needs by *composing* a narrower Platform, and every member of every port
 * it names is then required. A host that cannot back a capability must not
 * claim it, rather than claim it and stub it.
 *
 * App-specific file operations (docs openDocx/saveDocx, PdfApi.save, the pptx
 * edit surface, the sheets workbook surface) stay in their apps by design. An
 * app intersects its own port into its slot type:
 *
 *   type PdfPlatform = Platform<'language' | 'ai'> & {
 *     file: PdfFilePort
 *     window: PdfWindowPort
 *   }
 *   export const { set: setPdfPlatform, get: pdfPlatform } =
 *     createPlatformSlot<PdfPlatform>('pdf')
 *
 * The same rule applies within a port catalogue entry: pdf backs part of
 * `WindowPort` (the dirty-state and close-guard handshake) but none of the tab
 * channels, so it narrows that one too rather than claiming the whole port.
 */
import type { AiChatPort, AiPort, AiSettingsPort, GensparkPort } from './ports/ai.js'
import type { AttachmentsPort } from './ports/attachments.js'
import type { LanguagePort } from './ports/language.js'
import type { ProjectPort } from './ports/project.js'
import type { SearchPort } from './ports/search.js'
import type { WindowPort } from './ports/window.js'

export type { AiChatPort, AiPort, AiSettingsPort, GensparkPort } from './ports/ai.js'
export type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  AttachmentsPort,
} from './ports/attachments.js'
export { ATTACHMENT_IMAGE_EXTS } from './ports/attachments.js'
export type { LanguagePort } from './ports/language.js'
export type {
  AppendChatArgs,
  ChatMessage,
  LoadChatArgs,
  ProjectPort,
  ProjectSummary,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
  TimelineEntry,
} from './ports/project.js'
export type {
  FetchedImage,
  ImageSearchHit,
  ImageSearchResult,
  SearchPort,
  WebSearchHit,
  WebSearchResult,
} from './ports/search.js'
export type { TabInfo, WindowPort } from './ports/window.js'

/**
 * The full catalogue of shared capability ports.
 *
 * The AI surface is four ports, not one: the ai:* ipcMain handlers come from a
 * single registration (docs-main's `registerAiIpc`) that some hosts never run,
 * and different preloads forward different subsets of it. See ports/ai.ts for
 * the availability table and the standalone-pdf finding behind the split.
 */
export interface PlatformPorts {
  language: LanguagePort
  ai: AiPort
  aiSettings: AiSettingsPort
  aiChat: AiChatPort
  genspark: GensparkPort
  search: SearchPort
  attachments: AttachmentsPort
  project: ProjectPort
  window: WindowPort
}

export type PortName = keyof PlatformPorts

/**
 * A host providing exactly the named capabilities — all required.
 *
 * `Platform<'language' | 'ai'>` is a host that provides those two ports in
 * full. Bare `Platform` is every port, for a host that backs the lot.
 */
export type Platform<K extends PortName = PortName> = Pick<PlatformPorts, K>

/** A typed, independently-scoped holder for one app's platform implementation. */
export interface PlatformSlot<P> {
  /**
   * Install the implementation. Called once during renderer bootstrap, before
   * any UI code runs; calling it again replaces the implementation, which
   * tests rely on.
   */
  set(platform: P): void
  /**
   * The installed implementation.
   *
   * @throws when nothing has been installed yet.
   */
  get(): P
}

/**
 * Create a platform slot.
 *
 * Deliberately a factory rather than a module-level singleton with a generic
 * getter: a `getPlatform<K>()` could not infer K from anything, so it would be
 * an unsound cast at every call site. Here P is fixed once, where the slot is
 * declared, and both set() and get() are checked against it. Each app owns its
 * own slot, so apps cannot clobber one another.
 *
 * @param label names the owner (usually the app) and appears in the
 *   before-set error, so a bootstrap-order mistake says which app is at fault.
 */
export function createPlatformSlot<P>(label: string): PlatformSlot<P> {
  let current: P | undefined
  return {
    set(platform: P): void {
      current = platform
    },
    get(): P {
      if (current === undefined) {
        throw new Error(
          `No platform implementation installed for "${label}". Call the slot's set() from the ` +
            `${label} renderer entry point (before rendering) with the Electron or Web implementation.`,
        )
      }
      return current
    },
  }
}
