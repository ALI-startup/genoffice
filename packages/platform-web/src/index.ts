/**
 * Browser implementations of the platform ports.
 *
 * The sibling of @genoffice/platform-electron, and it obeys the same two rules:
 * nothing here imports an app, and nothing here claims a capability it cannot
 * honestly back. What it adds over the Electron package is `WebDocumentStore` —
 * Electron gets its ref → file mapping for free (the ref is a path), while a
 * browser has to own that mapping itself.
 *
 * App-specific surfaces (pdf's document operations, the Save As handshake) are
 * assembled in the app from these pieces, exactly as the Electron side does.
 */
export {
  browserFilePickers,
  browserMultiFilePicker,
  DOCUMENT_FILE_TYPES,
  DOCX_FILE_TYPES,
  ensurePermission,
  FilePermissionDeniedError,
  HWPX_FILE_TYPES,
  IMAGE_FILE_TYPES,
  isPickerCancel,
  PDF_FILE_TYPES,
} from './fs-access.js'
export type {
  DirectoryPickerOptions,
  FilePickerAcceptType,
  FilePickers,
  FsPermissionDescriptor,
  FsPermissionMode,
  FsPermissionState,
  MultiFilePicker,
  OpenFilePickerOptions,
  SaveFilePickerOptions,
  WebDirectoryHandle,
  WebFile,
  WebFileHandle,
  WebPermissionAware,
  WebWritableFile,
} from './fs-access.js'

export {
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TEXT_EXTS,
  createWebAttachmentsPort,
} from './attachments.js'
export type {
  WebAttachmentExtractor,
  WebAttachmentSource,
  WebAttachmentsOptions,
  WebAttachmentText,
} from './attachments.js'

export {
  createIndexedDbHandleStore,
  createMemoryHandleStore,
  DOCUMENT_DB_NAME,
  DOCUMENT_STORE_NAME,
} from './handle-store.js'
export type { DocumentHandleStore, StoredDocumentHandle } from './handle-store.js'

export { UnknownDocumentError, WebDocumentStore } from './document-store.js'
export type {
  WebDirectory,
  WebDocument,
  WebDocumentStoreOptions,
  WebRecentDocument,
  WriteOptions,
} from './document-store.js'

export {
  browserLanguageEnv,
  createWebLanguagePort,
  LANGUAGE_STORAGE_KEY,
  setWebLanguage,
} from './language.js'
export type { LanguageHostEnv } from './language.js'

export { browserDownloadEnv, DOWNLOAD_URL_TTL_MS, downloadBytes } from './download.js'
export type { DownloadEnv } from './download.js'

export { createWebUnloadPrompt, createWebWindowPort } from './window.js'
export type { CloseGuardEnv, WebWindowSlice } from './window.js'

export { createWebAiPort, fetchPublicAiSettings, toAiSettings } from './ai.js'
export type { WebAiPortOptions } from './ai.js'

export { browserFrameChildEnv, createFrameChildLink, frameIdFromLocation } from './frame-child.js'
export type { FrameChildEnv, FrameChildLink } from './frame-child.js'

export {
  browserShellFrameLinkEnv,
  createShellFrameLink,
  FRAME_REPLY_TIMEOUT_MS,
} from './frame-host.js'
export type { ShellFrameLink, ShellFrameLinkEnv, ShellFrameTarget } from './frame-host.js'

export {
  FRAME_ID_PARAM,
  FRAME_PROTOCOL,
  parseFrameToShell,
  parseShellToFrame,
} from './frame-wire.js'
export type { FrameMessageLike, FrameToShellMessage, ShellToFrameMessage } from './frame-wire.js'

export { AI_BFF_BASE_PATH, AI_BFF_ROUTES } from './ai-wire.js'
export type {
  AiCancelBody,
  AiChatBody,
  AiStreamBody,
  PublicAiProviderSettings,
  PublicAiSettings,
} from './ai-wire.js'
