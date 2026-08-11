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
  ensurePermission,
  FilePermissionDeniedError,
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
  OpenFilePickerOptions,
  SaveFilePickerOptions,
  WebDirectoryHandle,
  WebFile,
  WebFileHandle,
  WebPermissionAware,
  WebWritableFile,
} from './fs-access.js'

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
} from './document-store.js'

export {
  browserLanguageEnv,
  createWebLanguagePort,
  LANGUAGE_STORAGE_KEY,
  setWebLanguage,
} from './language.js'
export type { LanguageHostEnv } from './language.js'

export { createWebWindowPort } from './window.js'
export type { CloseGuardEnv, WebWindowSlice } from './window.js'

export { createWebAiPort, toAiSettings } from './ai.js'
export type { WebAiPortOptions } from './ai.js'

export { AI_BFF_BASE_PATH, AI_BFF_ROUTES } from './ai-wire.js'
export type {
  AiCancelBody,
  AiChatBody,
  AiStreamBody,
  PublicAiProviderSettings,
  PublicAiSettings,
} from './ai-wire.js'
