/**
 * Chat attachments capability (local files fed to the agent via tools).
 *
 * Phase 1 recorded this port as unimplementable on the web because every member
 * was path-based, and singled out `getPathForFile(file: File): string` as the
 * sharp edge: a web host had nothing to return but `''`, a falsy value that
 * type-checks as a valid path, flows onward and fails silently downstream.
 *
 * Resolved as proposed. `path` is gone; the host issues an opaque
 * `AttachmentRef` and is the only side that resolves it — the same
 * opaque-handle move as `DocumentRef` in apps/pdf's platform. Electron maps a
 * ref to an absolute path, a browser host maps it to a stored blob, and no
 * renderer code can tell the difference because nothing in the renderer may
 * parse, split or construct a ref.
 *
 * `getPathForFile` became `refForFile(file): Promise<AttachmentRef | null>`.
 * The nullability is not the old silent failure wearing a new name: `null` is
 * not assignable to `AttachmentRef`, so a caller cannot forward it by accident
 * — it has to branch — and the branch is meaningful rather than an error path.
 * A File the host cannot address is exactly the clipboard-bitmap case that
 * `addPastedImage` exists for, which is how the docs AI panel already used the
 * old empty-string return.
 *
 * apps/docs (DesktopApi), apps/slides (DesktopFilesApi) and apps/sheets
 * (DesktopApi) still declare the original path-based methods on their preload
 * bridges; those bridges are unchanged and the Electron adapter does the
 * ref↔path mapping. apps/pdf's preload forwards none of them (it has no chat
 * surface), which is a preload gap, not a host capability gap.
 */

/** Image attachment extensions: no text extraction; read as base64 and passed to the model as a multimodal image. */
export const ATTACHMENT_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

/**
 * Opaque handle to one attachment, issued by the host.
 *
 * The renderer stores it, compares it for identity and hands it back — nothing
 * more. It must never be parsed, split, displayed or built: Electron's happens
 * to be an absolute path, a browser host's is a key into its own blob store,
 * and only the host that issued a ref may interpret it. Use `AttachmentMeta`
 * for anything the UI has to show.
 */
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
   * Human-readable location for display only (the attachment chip's tooltip),
   * or undefined when the host has none. Never parsed, never passed back to the
   * host — use `ref` for that. Electron supplies the absolute path; a browser
   * host supplies nothing, since a picked File exposes no location.
   *
   * Optional on purpose, and not a breach of this package's no-optional-members
   * rule: that rule bans optional *methods*, which let a host claim a
   * capability and silently no-op it. This is a *data* field describing
   * something a host genuinely may not possess, and every consumer has to
   * handle its absence explicitly. Same reasoning as `PendingDocument.location`
   * in apps/pdf.
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
   * Resolve a File the user dropped or pasted into a ref this host can address
   * later, or `null` when it cannot address that File at all.
   *
   * `null` is a real answer, not a failure: a clipboard bitmap has no backing
   * file anywhere, and the caller's response is to hand the bytes over through
   * `addPastedImage` instead. Async because a host may have to persist the blob
   * before it can name it; Electron's answer is synchronous underneath.
   *
   * Issuing a ref is not accepting the attachment — `addAttachments` still
   * validates size and type and is what produces the metadata.
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
