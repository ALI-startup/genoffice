/**
 * sheets' host module, filled into the platform slot at boot, and the only file in the web bundle
 * that reads a global.
 */
import {
  browserFilePickers,
  browserLanguageEnv,
  browserMultiFilePicker,
  createBrowserAttachmentExtractor,
  createWebHwpConvertPort,
  createFrameChildLink,
  createWebAiPort,
  createWebAttachmentsPort,
  createWebLanguagePort,
} from '@samugen/platform-web'
import { t } from './i18n/locale'
import type { CreateSheetsPlatform } from './platform'
import { createWebSheetsPlatform } from './platform-web'
import { XlsxWorkerClient } from './wasm/client'
// Vite resolves both to URLs the bundle ships: the Worker as its own chunk, the engine as an asset.
import EngineWorker from './wasm/worker?worker'
import engineWasmUrl from './wasm/xlsx-sidecar.wasm?url'

export const createSheetsPlatform: CreateSheetsPlatform = async () => {
  const languageEnv = browserLanguageEnv()
  return createWebSheetsPlatform({
    client: new XlsxWorkerClient(new EngineWorker() as unknown as never, engineWasmUrl),
    pickers: browserFilePickers(),
    language: createWebLanguagePort(languageEnv),
    ai: createWebAiPort(),
    attachments: createWebAttachmentsPort({
      pick: browserMultiFilePicker(),
      // The `.hwp` converter, always wired: whether a deployment actually runs the service is not
      // knowable synchronously, and the port answers a missing one with a message naming the fix
      // (save it as .hwpx) rather than a failure.
      extractor: createBrowserAttachmentExtractor({ hwp: createWebHwpConvertPort() }),
    }),
    // The browser's own dialog, standing in for the native warning box the Electron main process
    // shows on the same condition.
    confirmOverwrite: () => window.confirm(t('appDiskChangedConfirm')),
    // Non-null only when the web shell hosts this page in its tab strip, which it signals with a
    // query parameter.
    frame: createFrameChildLink(),
  })
}
