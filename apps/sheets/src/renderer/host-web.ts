/**
 * The browser half of sheets' host seam — the counterpart of host-electron.ts, and the only
 * file in the web bundle that reads a global.
 *
 * `vite.web.config.ts` aliases `@host` here, so nothing in this file (nor anything it
 * imports) reaches the Electron bundle, and `window.desktopApi` is never referenced: there is
 * no preload bridge on this host, and the spreadsheet engine runs in a Worker of this page.
 *
 * The Worker is started here rather than in platform-web.ts for the usual reason — that
 * module touches no globals — and lazily inside the client, so a session that never opens a
 * workbook never downloads 4.5MB of engine.
 */
import {
  browserFilePickers,
  browserLanguageEnv,
  browserMultiFilePicker,
  createBrowserAttachmentExtractor,
  createFrameChildLink,
  createWebAiPort,
  createWebAttachmentsPort,
  createWebLanguagePort,
} from '@samugen/platform-web'
import { t } from './i18n/locale'
import type { CreateSheetsPlatform } from './platform'
import { createWebSheetsPlatform } from './platform-web'
import { XlsxWorkerClient } from './wasm/client'
// Vite resolves both to URLs the bundle ships: the Worker as its own chunk, the engine as an
// asset. Neither is inlined, so the engine is fetched only when a workbook is opened.
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
      extractor: createBrowserAttachmentExtractor(),
    }),
    // The browser's own dialog, standing in for the native warning box the Electron main
    // process shows on the same condition. Blocking and synchronous, which is what the
    // decision needs: the answer has to be in hand before anything is written.
    confirmOverwrite: () => window.confirm(t('appDiskChangedConfirm')),
    // Non-null only when the web shell hosts this page in its tab strip, which it signals with
    // a query parameter. Closing a shell tab removes the iframe, and `beforeunload` does not
    // fire for that, so this is what lets the shell ask the workbook whether it has unsaved
    // work — and ask it to save.
    frame: createFrameChildLink(),
  })
}
