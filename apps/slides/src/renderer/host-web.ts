/**
 * slides' host module, filled into the platform slot at boot, and the only file in the web bundle
 * that reads a global.
 */
import { CanvasMetrics, HeuristicMetrics, type FontMetricsProvider } from '@samugen/pptx-render'
import {
  browserDownloadEnv,
  browserFilePickers,
  browserLanguageEnv,
  browserMultiFilePicker,
  createBrowserAttachmentExtractor,
  createWebHwpConvertPort,
  createFrameChildLink,
  createIndexedDbHandleStore,
  createWebAiPort,
  createWebAttachmentsPort,
  createWebLanguagePort,
  downloadBytes,
  DOCUMENT_DB_NAME,
  PRESENTATION_FILE_TYPES,
  WebDocumentStore,
} from '@samugen/platform-web'
import { setSlideRenderEnv } from '../domain/session'
import type { OpsLabelKey, OpsTranslate } from '../domain/ops'
import { tOps } from '../shared/ops-i18n'
import { getLang } from './i18n/locale'
import { displayFontFamily } from './konva-adapter'
import type { CreateSlidesPlatform } from './platform'
import { createWebSlidesPlatform, PPTX_MIME, WebSlidesSession } from './platform-web'

/** Text metrics for this host: the browser's own text engine, through a detached canvas. */
function webFontMetrics(): FontMetricsProvider {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return new HeuristicMetrics()
  return new CanvasMetrics(context, { familyStack: displayFontFamily })
}

/** MIME by extension, so `createImageBitmap` gets a Blob it can sniff. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

/** An image's own pixel size, measured by the browser's decoder. */
async function imageSize(
  bytes: Uint8Array,
  ext: string,
): Promise<{ width: number; height: number } | null> {
  const type = IMAGE_MIME[ext.toLowerCase()]
  if (!type) return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }))
  } catch {
    return null
  }
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return size
}

/** Print the deck's HTML from a hidden iframe. */
function printFrame(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
    frame.srcdoc = html
    const done = (finish: () => void) => () => {
      frame.remove()
      finish()
    }
    frame.onerror = done(() => reject(new Error('the print document failed to load')))
    frame.onload = () => {
      const view = frame.contentWindow
      if (!view) {
        done(() => reject(new Error('the print document has no window')))()
        return
      }
      view.addEventListener('afterprint', done(resolve), { once: true })
      try {
        view.focus()
        view.print()
      } catch (error) {
        done(() => reject(error))()
      }
    }
    document.body.appendChild(frame)
  })
}

export const createSlidesPlatform: CreateSlidesPlatform = async () => {
  // Installed before any port exists: every rebuild of a RenderSlide reads this slot, and
  // the slot throws until it is set. Electron installs the same slot from its main process.
  setSlideRenderEnv({
    metrics: webFontMetrics(),
    // Chromium decodes no TIFF, and this host has no decoder of its own to offer.
    decodeTiff: null,
  })
  const pickers = browserFilePickers()
  const session = new WebSlidesSession()
  const store = new WebDocumentStore({
    // Handles are structured-cloneable, so IndexedDB stores the handle itself and a deck survives a
    // reload without copying bytes or inventing a path.
    handles: createIndexedDbHandleStore(indexedDB, `${DOCUMENT_DB_NAME}-slides`),
    pickers,
    fileTypes: PRESENTATION_FILE_TYPES,
    pickerId: 'samugen-pptx',
  })
  /** The operations' labels, in the UI language. */
  const translate: OpsTranslate = (key, params) => tOps(getLang(), key, params)
  /**
   * The chart warning comes from the same dictionary but is not part of `OpsTranslate`: the host
   * asks it, the operation never does.
   */
  const say = (key: Exclude<Parameters<typeof tOps>[1], OpsLabelKey>) => tOps(getLang(), key)
  return createWebSlidesPlatform({
    session,
    store,
    pickers,
    language: createWebLanguagePort(browserLanguageEnv()),
    ai: createWebAiPort(),
    attachments: createWebAttachmentsPort({
      pick: browserMultiFilePicker(),
      // The `.hwp` converter, always wired: whether a deployment actually runs the service is not
      // knowable synchronously, and the port answers a missing one with a message naming the fix
      // (save it as .hwpx) rather than a failure.
      extractor: createBrowserAttachmentExtractor({ hwp: createWebHwpConvertPort() }),
    }),
    document: {
      // The desktop uses the system account name; a page has no equivalent and inventing one would
      // put a fiction in the document.
      commentAuthor: () => 'User',
      translate,
      // The browser's own dialog, standing in for the native warning box the Electron main process
      // shows on the same condition.
      confirmChartSimplify: async () =>
        window.confirm(`${say('chartSimplifyTitle')}\n\n${say('chartSimplifyBody')}`),
    },
    imageSize,
    download: (fileName, bytes) => downloadBytes(browserDownloadEnv(), fileName, bytes, PPTX_MIME),
    printFrame,
    // Non-null only when the web shell hosts this page in its tab strip, which it signals with a
    // query parameter.
    frame: createFrameChildLink(),
  })
}
