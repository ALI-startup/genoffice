/**
 * Chat attachments capability (local files fed to the agent via tools).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ UNRESOLVED: this port cannot be implemented on the web as written.       │
 * │                                                                          │
 * │ Every member is path-based, and browsers have no file paths:             │
 * │   - AttachmentMeta.path is an absolute local path                        │
 * │   - addAttachmentPaths(paths: string[]) takes absolute paths             │
 * │   - readAttachment(path, ...) / readAttachmentImage(path) key off them   │
 * │   - getPathForFile(file) is Electron webUtils and has nothing to return  │
 * │     on the web                                                           │
 * │                                                                          │
 * │ getPathForFile is the sharp edge: a web implementation would have to     │
 * │ return '' — a falsy value that type-checks, flows onward, and fails      │
 * │ silently downstream. That is exactly the class of failure this package   │
 * │ exists to remove, so it must NOT be the answer we ship.                  │
 * │                                                                          │
 * │ Likely resolution: replace `path` with an opaque host-issued             │
 * │ `AttachmentRef` token. The host keeps the ref↔path (or ref↔blob)         │
 * │ mapping privately; renderer code passes refs around and never sees a     │
 * │ filesystem path. Electron maps a ref to a real path, the web host maps   │
 * │ it to an uploaded blob — and getPathForFile becomes something like       │
 * │ refForFile(file): Promise<AttachmentRef>, which both hosts can honor.    │
 * │                                                                          │
 * │ Decision deferred to Phase 3, when the first web adapter is built and    │
 * │ the constraint is concrete. The port is kept path-shaped for now so the  │
 * │ Electron adapter is a faithful 1:1 of today's behavior.                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * apps/docs (DesktopApi), apps/slides (DesktopFilesApi) and apps/sheets
 * (DesktopApi) declare byte-for-byte identical signatures for these six
 * methods — slides deliberately copied the docs names so the files skill could
 * be reused wholesale. apps/pdf's preload forwards none of them (it has no
 * chat surface), which is a preload gap, not a host capability gap.
 */

/** Image attachment extensions: no text extraction; read as base64 and passed to the model as a multimodal image. */
export const ATTACHMENT_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

export interface AttachmentMeta {
  /** Absolute local path; the file never leaves the machine. See the header note — this becomes an opaque ref in Phase 3. */
  path: string
  name: string
  /** Lowercased extension, without the dot. */
  ext: string
  sizeBytes: number
}

export interface AttachmentAddResult {
  accepted: AttachmentMeta[]
  /** Per-file rejection reason (too large / unsupported type / unreadable). */
  rejected: string[]
}

export interface AttachmentReadResult {
  ok: boolean
  error?: string
  name?: string
  /** Total character count of the extracted text. */
  totalChars?: number
  /** The requested slice. */
  text?: string
  offset?: number
}

export interface AttachmentImageResult {
  ok: boolean
  /** Raw base64, without the data: prefix. */
  base64?: string
  mime?: string
  error?: string
}

export interface AttachmentsPort {
  /** Multi-select attachment file dialog; null on cancel. */
  pickAttachments(): Promise<AttachmentAddResult | null>
  /** Validate dropped paths and return attachment metadata. */
  addAttachmentPaths(paths: string[]): Promise<AttachmentAddResult>
  /** Persist a clipboard-pasted image (no local path) and add it as an attachment. */
  addPastedImage(data: ArrayBuffer, ext: string): Promise<AttachmentAddResult>
  /** Read a slice of an attachment's extracted text. */
  readAttachment(path: string, offset: number, maxChars: number): Promise<AttachmentReadResult>
  /** Read an image attachment as base64 for multimodal input. */
  readAttachmentImage(path: string): Promise<AttachmentImageResult>
  /**
   * Absolute path of a File dropped onto the window (Electron webUtils).
   * Synchronous by contract. Not web-implementable — see the header note.
   */
  getPathForFile(file: File): string
}
