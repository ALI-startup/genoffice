/** Chat attachments capability (local files fed to the agent via tools). */

/** Image attachment extensions: no text extraction; read as base64 and passed to the model as a multimodal image. */
export const ATTACHMENT_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

/** Opaque handle to one attachment, issued by the host. */
export type AttachmentRef = string

export interface AttachmentMeta {
  /** Host-issued handle; also the attachment's identity in renderer state. */
  ref: AttachmentRef
  /** Display name, e.g. `notes.md`. The host supplies it — the renderer cannot derive one from an opaque ref. */
  name: string
  /** Lowercased extension, without the dot. Drives the image/text split (see ATTACHMENT_IMAGE_EXTS). */
  ext: string
  sizeBytes: number
  /**
   * Human-readable location for display only (the attachment chip's tooltip), or undefined when the
   * host has none.
   */
  location?: string
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
  /**
   * Resolve a File the user dropped or pasted into a ref this host can address later, or `null`
   * when it cannot address that File at all.
   */
  refForFile(file: File): Promise<AttachmentRef | null>
  /** Validate refs and return attachment metadata for the ones accepted. */
  addAttachments(refs: AttachmentRef[]): Promise<AttachmentAddResult>
  /** Store bytes with no backing file (a pasted screenshot) and add them as an attachment. */
  addPastedImage(data: ArrayBuffer, ext: string): Promise<AttachmentAddResult>
  /** Read a slice of an attachment's extracted text. */
  readAttachment(
    ref: AttachmentRef,
    offset: number,
    maxChars: number,
  ): Promise<AttachmentReadResult>
  /** Read an image attachment as base64 for multimodal input. */
  readAttachmentImage(ref: AttachmentRef): Promise<AttachmentImageResult>
}
