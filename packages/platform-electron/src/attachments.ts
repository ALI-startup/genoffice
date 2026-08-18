/**
 * `AttachmentsPort` over an Electron preload bridge.
 *
 * The one adapter in this package that is not per-app. apps/docs, apps/slides and
 * apps/sheets each declare the same six path-based attachment methods on their own
 * preload bridge — `DesktopApi` in docs and sheets, `DesktopFilesApi` in slides —
 * because slides' surface was copied from docs' wholesale. The ref↔path mapping is
 * therefore identical for all three, and writing it once means a browser host cannot
 * disagree with a desktop host about what a ref means in one app and not another.
 *
 * Electron's `AttachmentRef` *is* the absolute path, so this module is the one place
 * allowed to read a ref as a path — that is what makes it the Electron adapter. Nothing
 * on any main-process side changes.
 *
 * The bridge type below is re-declared rather than imported (packages must not depend
 * on apps); each app's bridge satisfies it structurally.
 */
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  AttachmentsPort,
} from '@genoffice/platform'

/** Attachment metadata as a preload bridge reports it: keyed by absolute path. */
export interface ElectronAttachmentMetaBridge {
  path: string
  name: string
  ext: string
  sizeBytes: number
}

export interface ElectronAttachmentAddResultBridge {
  accepted: ElectronAttachmentMetaBridge[]
  rejected: string[]
}

/** The attachment members of a preload bridge — all six path-based, all six unchanged. */
export interface ElectronAttachmentsBridge {
  pickAttachments(): Promise<ElectronAttachmentAddResultBridge | null>
  addAttachmentPaths(paths: string[]): Promise<ElectronAttachmentAddResultBridge>
  addPastedImage(data: ArrayBuffer, ext: string): Promise<ElectronAttachmentAddResultBridge>
  readAttachment(path: string, offset: number, maxChars: number): Promise<AttachmentReadResult>
  readAttachmentImage(path: string): Promise<AttachmentImageResult>
  getPathForFile(file: File): string
}

/** Bridge metadata → port metadata: the path becomes both the ref and the display location. */
function toAttachmentMeta(meta: ElectronAttachmentMetaBridge): AttachmentMeta {
  return {
    ref: meta.path,
    name: meta.name,
    ext: meta.ext,
    sizeBytes: meta.sizeBytes,
    // This host has a real location, so the attachment chip's tooltip keeps
    // showing the absolute path exactly as it always has.
    location: meta.path,
  }
}

function toAddResult(result: ElectronAttachmentAddResultBridge): AttachmentAddResult {
  return { accepted: result.accepted.map(toAttachmentMeta), rejected: result.rejected }
}

/** AttachmentsPort over a preload bridge's path-based attachment methods. */
export function createElectronAttachmentsPort(bridge: ElectronAttachmentsBridge): AttachmentsPort {
  return {
    pickAttachments: async () => {
      const result = await bridge.pickAttachments()
      return result ? toAddResult(result) : null
    },
    // webUtils.getPathForFile returns '' for a File with no backing file (a
    // clipboard bitmap). That empty string is the whole reason this port was
    // reshaped: it type-checked as a path and flowed onward. It stops here and
    // becomes an explicit null the caller has to branch on.
    refForFile: async (file) => bridge.getPathForFile(file) || null,
    addAttachments: async (refs) => toAddResult(await bridge.addAttachmentPaths(refs)),
    addPastedImage: async (data, ext) => toAddResult(await bridge.addPastedImage(data, ext)),
    readAttachment: (ref, offset, maxChars) => bridge.readAttachment(ref, offset, maxChars),
    readAttachmentImage: (ref) => bridge.readAttachmentImage(ref),
  }
}
