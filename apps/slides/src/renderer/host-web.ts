/**
 * The browser half of slides' build-time host seam — the counterpart of host-electron.ts,
 * and the only file in the web bundle that reads a global.
 *
 * `vite.web.config.ts` aliases `@host` here, so nothing in this file (nor anything it
 * imports) reaches the Electron bundle, and `window.slidesApi` is never referenced: there is
 * no preload bridge on this host, and the deck lives in the page.
 *
 * Everything below is a browser surface the ports refuse to touch themselves — the pickers,
 * IndexedDB, the downloads, an iframe to print from, `createImageBitmap` — plus the two
 * services the operations need a host to answer: the comment author, and the warning shown
 * before an imported chart is rebuilt.
 *
 * The AI port takes no configuration. It calls the BFF's routes on this origin, which the
 * dev server proxies — see `vite.web.config.ts`. That indirection is required, not cosmetic:
 * the page's CSP is `connect-src 'self'`, so a cross-origin AI request would be blocked by
 * the browser, and same-origin is also what keeps every credential out of this page.
 */
import { CanvasMetrics, HeuristicMetrics, type FontMetricsProvider } from '@samugen/pptx-render'
import {
  browserDownloadEnv,
  browserFilePickers,
  browserLanguageEnv,
  browserMultiFilePicker,
  createBrowserAttachmentExtractor,
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

/**
 * Text metrics for this host: the browser's own text engine, through a detached canvas.
 *
 * Electron parses font files with opentype.js because its layout runs in the main process,
 * where no canvas exists. A page cannot read font files at all without the
 * `queryLocalFonts()` permission — and does not need to, because it *is* what will draw the
 * text. Measuring through the same engine, with the same font stack `glyphToDraw` hands
 * Konva, makes layout and drawing agree by construction, and gets kerning and Arabic/Indic
 * shaping right for free (the desktop needs HarfBuzz alongside opentype for the latter).
 *
 * `HeuristicMetrics` remains the answer where there is no 2D context — jsdom, or a browser
 * that refuses one under memory pressure — so this never fails to produce a layout.
 */
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

/**
 * An image's own pixel size, measured by the browser's decoder.
 *
 * `null` for anything it cannot decode — TIFF, most notably, which Chromium does not read at
 * all — and the insert then falls back to a 4:3 box exactly as the desktop does for an image
 * it cannot measure.
 */
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

/**
 * Print the deck's HTML from a hidden iframe.
 *
 * The page itself is the editor, so `window.print()` would print the editor — the same
 * reason Electron builds a hidden window for this. `srcdoc` keeps the frame same-origin, so
 * this page can call `print()` on it and hear `afterprint` back; the slide images are data
 * URLs already, so nothing is fetched and the CSP is not involved.
 *
 * Resolves when the print dialog closes, whether the user printed or cancelled — a page is
 * told which of the two happened by no browser, which is why the port reports only that the
 * flow ran.
 */
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
    // Chromium decodes no TIFF, and this host has no decoder of its own to offer. `null` is
    // the interface's way of saying so: those pictures render blank rather than silently
    // wrong, and the archive keeps their original bytes, so saving is unaffected.
    decodeTiff: null,
  })
  const pickers = browserFilePickers()
  const session = new WebSlidesSession()
  const store = new WebDocumentStore({
    // Handles are structured-cloneable, so IndexedDB stores the handle itself and a deck
    // survives a reload without copying bytes or inventing a path. The database name is
    // per-app because the store's list() is an unfiltered getAll(): a shared database would
    // put this app's decks in another app's recent list on the same origin.
    handles: createIndexedDbHandleStore(indexedDB, `${DOCUMENT_DB_NAME}-slides`),
    pickers,
    fileTypes: PRESENTATION_FILE_TYPES,
    pickerId: 'samugen-pptx',
  })
  /**
   * The operations' labels, in the UI language. `getLang()` is read per call rather than
   * captured, so a language change mid-session is reflected without rebuilding the platform.
   */
  const translate: OpsTranslate = (key, params) => tOps(getLang(), key, params)
  /**
   * The chart warning comes from the same dictionary but is not part of `OpsTranslate`: the
   * host asks it, the operation never does. Hence the separate binding rather than widening
   * the port's key union with something no operation can request.
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
      extractor: createBrowserAttachmentExtractor(),
    }),
    document: {
      // The desktop uses the system account name; a page has no equivalent and inventing one
      // would put a fiction in the document. Electron's own fallback for an unreadable
      // account is this exact label, so a comment made here looks like one made there when
      // the desktop cannot name the user either.
      commentAuthor: () => 'User',
      translate,
      // The browser's own dialog, standing in for the native warning box the Electron main
      // process shows on the same condition. Blocking and synchronous, which is what the
      // decision needs: the answer must be in hand before the chart is rebuilt.
      confirmChartSimplify: async () =>
        window.confirm(`${say('chartSimplifyTitle')}\n\n${say('chartSimplifyBody')}`),
    },
    imageSize,
    download: (fileName, bytes) => downloadBytes(browserDownloadEnv(), fileName, bytes, PPTX_MIME),
    printFrame,
    // Non-null only when the web shell hosts this page in its tab strip, which it signals
    // with a query parameter. Closing a shell tab removes the iframe, and `beforeunload`
    // does not fire for that, so this is what lets the shell ask the deck whether it has
    // unsaved work — and ask it to save. Standalone there is no shell, this is null, and
    // nothing about the page changes.
    frame: createFrameChildLink(),
  })
}
