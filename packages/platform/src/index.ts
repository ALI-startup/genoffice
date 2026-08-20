/** Platform abstraction seam. */
import type { AiPort } from './ports/ai.js'
import type { AttachmentsPort } from './ports/attachments.js'
import type { LanguagePort } from './ports/language.js'
import type { ProjectPort } from './ports/project.js'
import type { SearchPort } from './ports/search.js'
import type { WindowPort } from './ports/window.js'

export type { AiPort } from './ports/ai.js'
export type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  AttachmentRef,
  AttachmentsPort,
} from './ports/attachments.js'
export { ATTACHMENT_IMAGE_EXTS } from './ports/attachments.js'
export { isExternallyModified } from './file-state.js'
export type { DiskFileState } from './file-state.js'
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

/** The full catalogue of shared capability ports. */
export interface PlatformPorts {
  language: LanguagePort
  ai: AiPort
  search: SearchPort
  attachments: AttachmentsPort
  project: ProjectPort
  window: WindowPort
}

export type PortName = keyof PlatformPorts

/** A host providing exactly the named capabilities — all required. */
export type Platform<K extends PortName = PortName> = Pick<PlatformPorts, K>

/** A typed, independently-scoped holder for one app's platform implementation. */
export interface PlatformSlot<P> {
  /** Install the implementation. */
  set(platform: P): void
  /** The installed implementation. */
  get(): P
}

/** Create a platform slot. */
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
