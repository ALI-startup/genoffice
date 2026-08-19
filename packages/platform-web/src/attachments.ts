/**
 * `AttachmentsPort` for a browser host.
 *
 * The port went ref-based in Phase 4a precisely so this could exist: Electron
 * resolves an `AttachmentRef` to an absolute path, and here the host resolves it
 * to a blob it is holding itself. The mapping is private to this module — the
 * renderer receives an opaque string and hands it back, and there is nothing in
 * a ref for it to parse even if it tried, because the refs are UUIDs.
 *
 * The blobs live in memory for the life of the page and nowhere else. That is a
 * deliberate difference from Electron, which has a path and can re-read the file
 * whenever it likes: a browser's `File` is a snapshot the page already holds, so
 * persisting it would mean *copying* every attachment into IndexedDB to buy a
 * capability nothing uses (attachments are picked, sent, and discarded within a
 * session). The consequence is stated rather than hidden: refs do not survive a
 * reload, and a ref from a previous page load fails with a real error instead of
 * reading empty text.
 *
 * Text extraction is *injected*, not imported. Which parsers a browser build
 * carries is a bundle-size decision belonging to the app, and some formats have
 * no client-side parser at all — see `WebAttachmentExtractor`. Injecting it also
 * keeps this package free of jszip / pdfjs, and keeps these tests free of
 * fixtures.
 */
import { ATTACHMENT_IMAGE_EXTS, type AttachmentsPort } from '@samugen/platform'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  AttachmentRef,
} from '@samugen/platform'
import type { WebFile } from './fs-access.js'
import type { MultiFilePicker } from './fs-access.js'

/** Mirrors apps/docs' main-process cap (docs-main.ts `ATTACHMENT_MAX_BYTES`). */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
/** Mirrors apps/docs' per-image multimodal cap (`ATTACHMENT_IMAGE_MAX_BYTES`). */
export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Extensions read as UTF-8 text; the same set apps/docs' main process accepts. */
export const ATTACHMENT_TEXT_EXTS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'rb',
  'sh',
  'sql',
  'css',
])

const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** What `extractText` reports. `ok: false` carries the reason; it never returns empty text to mean failure. */
export interface WebAttachmentText {
  ok: boolean
  text?: string
  error?: string
}

/**
 * Turn an attachment's bytes into text, or say why it cannot be done.
 *
 * The extractor also decides which non-image extensions are accepted at all:
 * `addAttachments` asks it via `supports(ext)`, so a format with no client-side
 * parser is rejected at add time with a reason the user sees, rather than
 * accepted and then found unreadable when the model asks for its contents.
 */
export interface WebAttachmentExtractor {
  supports(ext: string): boolean
  extract(file: WebAttachmentSource): Promise<WebAttachmentText>
}

/** The attachment as the extractor sees it. */
export interface WebAttachmentSource {
  name: string
  /** Lowercased extension, no dot. */
  ext: string
  bytes(): Promise<Uint8Array>
}

export interface WebAttachmentsOptions {
  /** Multi-select attachment dialog; `null` on cancel. */
  pick: MultiFilePicker
  extractor: WebAttachmentExtractor
  /** Injected for tests; production uses `crypto.randomUUID`. */
  newRef?: () => string
  /** How many extracted texts to keep. Mirrors the main process's bound of 8. */
  textCacheSize?: number
}

/** One held attachment: the blob plus what the renderer is allowed to see about it. */
interface HeldAttachment {
  ref: AttachmentRef
  name: string
  ext: string
  sizeBytes: number
  blob: WebFile
}

export function createWebAttachmentsPort(options: WebAttachmentsOptions): AttachmentsPort {
  const newRef = options.newRef ?? (() => crypto.randomUUID())
  const cacheLimit = options.textCacheSize ?? 8
  /** The private ref → blob mapping. Nothing outside this closure can read it. */
  const held = new Map<AttachmentRef, HeldAttachment>()
  /** Extracted text, keyed by ref. A blob never changes, so an entry never goes stale. */
  const texts = new Map<AttachmentRef, string>()

  /** Issue a ref for a blob without accepting it yet — validation is addAttachments' job. */
  const hold = (blob: WebFile): AttachmentRef => {
    const ref = newRef()
    held.set(ref, {
      ref,
      name: blob.name,
      ext: extensionOf(blob.name),
      sizeBytes: blob.size,
      blob,
    })
    return ref
  }

  const validate = (entry: HeldAttachment): { meta?: AttachmentMeta; error?: string } => {
    const { name, ext, sizeBytes } = entry
    const isImage = ATTACHMENT_IMAGE_EXTS.has(ext)
    if (!isImage && !options.extractor.supports(ext)) {
      return { error: `${name}: unsupported file type (.${ext || 'unknown'})` }
    }
    if (sizeBytes > ATTACHMENT_MAX_BYTES) {
      return { error: `${name}: larger than ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB` }
    }
    if (isImage && sizeBytes > ATTACHMENT_IMAGE_MAX_BYTES) {
      return {
        error: `${name}: image larger than ${Math.round(ATTACHMENT_IMAGE_MAX_BYTES / 1024 / 1024)}MB`,
      }
    }
    // No `location`: a picked File exposes no path, and inventing one would put a
    // fiction in the attachment chip's tooltip. The field is optional for exactly
    // this host — see @samugen/platform's ports/attachments.ts.
    return { meta: { ref: entry.ref, name, ext, sizeBytes } }
  }

  const accept = (refs: AttachmentRef[]): AttachmentAddResult => {
    const accepted: AttachmentMeta[] = []
    const rejected: string[] = []
    for (const ref of refs) {
      const entry = held.get(ref)
      if (!entry) {
        // Not a silent drop: a ref this host never issued (or one from a previous
        // page load, since blobs are per-session) is reported like any other
        // rejection so the user sees that the file did not attach.
        rejected.push('an attachment is no longer available; add the file again')
        continue
      }
      const { meta, error } = validate(entry)
      if (meta) accepted.push(meta)
      else if (error) rejected.push(error)
    }
    return { accepted, rejected }
  }

  const bytesOf = async (entry: HeldAttachment): Promise<Uint8Array> =>
    new Uint8Array(await entry.blob.arrayBuffer())

  const textOf = async (entry: HeldAttachment): Promise<string> => {
    const cached = texts.get(entry.ref)
    if (cached !== undefined) return cached
    const parsed = await options.extractor.extract({
      name: entry.name,
      ext: entry.ext,
      bytes: () => bytesOf(entry),
    })
    if (!parsed.ok || parsed.text === undefined) {
      throw new Error(parsed.error ?? 'could not extract text')
    }
    texts.set(entry.ref, parsed.text)
    // Keep the cache bounded exactly as the main process does; insertion order
    // makes the first key the oldest.
    if (texts.size > cacheLimit) {
      const oldest = texts.keys().next().value
      if (oldest !== undefined) texts.delete(oldest)
    }
    return parsed.text
  }

  return {
    async pickAttachments(): Promise<AttachmentAddResult | null> {
      const files = await options.pick({ id: 'samugen-attachments' })
      if (files === null) return null
      return accept(files.map(hold))
    },

    /**
     * Every `File` a browser hands over can be held, so this returns a ref for
     * all of them — including a clipboard bitmap, which has bytes even though it
     * has no file behind it.
     *
     * That is not the Electron behaviour and it is not meant to be: Electron
     * returns `null` for a bitmap because it has no *path* to name, which is a
     * limitation of using paths as refs. A blob-holding host has no such
     * limitation, so `addPastedImage` stays available for callers that reach for
     * it but is never *forced* here. `null` is still reachable — an empty
     * `File`, which a browser produces for a directory dropped onto the page,
     * cannot be an attachment.
     */
    async refForFile(file: File): Promise<AttachmentRef | null> {
      if (file.size === 0) return null
      return hold(file)
    },

    async addAttachments(refs: AttachmentRef[]): Promise<AttachmentAddResult> {
      return accept(refs)
    },

    async addPastedImage(data: ArrayBuffer, ext: string): Promise<AttachmentAddResult> {
      const clean = ext.toLowerCase()
      if (!ATTACHMENT_IMAGE_EXTS.has(clean)) {
        return {
          accepted: [],
          rejected: [`pasted content is not an image (.${clean || 'unknown'})`],
        }
      }
      if (data.byteLength === 0) return { accepted: [], rejected: ['pasted image was empty'] }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
      return accept([
        hold({
          name: `pasted-${stamp}.${clean}`,
          size: data.byteLength,
          // Pasted bytes have no file behind them, so "last modified" is now.
          // Unused by this port (attachments are never written back), but `WebFile`
          // requires it because the document store's conflict check does.
          lastModified: Date.now(),
          arrayBuffer: async () => data,
        }),
      ])
    },

    async readAttachment(
      ref: AttachmentRef,
      offset: number,
      maxChars: number,
    ): Promise<AttachmentReadResult> {
      const entry = held.get(ref)
      if (!entry) return { ok: false, error: unknownRef(ref) }
      try {
        const text = await textOf(entry)
        const start = Math.max(0, Math.min(offset, text.length))
        return {
          ok: true,
          name: entry.name,
          totalChars: text.length,
          offset: start,
          text: text.slice(start, start + Math.max(0, maxChars)),
        }
      } catch (error) {
        return { ok: false, name: entry.name, error: messageOf(error) }
      }
    },

    async readAttachmentImage(ref: AttachmentRef): Promise<AttachmentImageResult> {
      const entry = held.get(ref)
      if (!entry) return { ok: false, error: unknownRef(ref) }
      const mime = ATTACHMENT_IMAGE_MIME[entry.ext]
      if (!mime) return { ok: false, error: `${entry.name} is not an image attachment` }
      try {
        return { ok: true, base64: toBase64(await bytesOf(entry)), mime }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

function unknownRef(ref: AttachmentRef): string {
  return (
    `Attachment ${ref} is no longer held by this page. Browser attachments live only for the ` +
    `life of the page, so add the file again.`
  )
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bytes → raw base64, without the `data:` prefix (which is what
 * `AttachmentImageResult.base64` is documented to carry).
 *
 * Chunked because `String.fromCharCode(...bytes)` blows the argument limit on a
 * multi-megabyte image, and the cap here is 5MB.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
