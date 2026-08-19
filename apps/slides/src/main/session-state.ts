/**
 * The Electron half of the slides session, and the host that installs its services.
 *
 * What is left here after the document session moved to src/domain/session.ts is
 * exactly what Electron owns: the `webContents.id → Session` registry (one session
 * per renderer, window or shell tab), the runtime paths a window is created from,
 * the window references dialogs are parented to, and the two services a RenderSlide
 * rebuild needs from the host — real system-font metrics and a TIFF decoder.
 *
 * Everything else is re-exported below rather than moved-and-repointed. That is a
 * deliberate choice for this phase: the importers (slides-main, ai-ipc,
 * presenter-show, attachments-ipc, tests/history.test.ts) keep importing from here,
 * so the relocation is invisible to them and Electron's behaviour cannot have
 * changed. Later phases can repoint call sites at `../domain/session` file by file.
 */
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import type { FontMetricsProvider } from '@samugen/pptx-render'
import { createSystemFontMetrics } from './fonts'
import { tiffToPng } from './tiff-decode'
import { setSlideRenderEnv, type Session } from '../domain/session'

export type { HistorySnapshot, Session, SlideRenderEnv } from '../domain/session'
export {
  beginHistoryBatch,
  buildAllRenderSlides,
  carryHistoryForReplacement,
  endHistoryBatch,
  getFontMetrics,
  makeMediaResolver,
  pushHistory,
  rebuildSlide,
  rebuildSlideWithReparse,
  registerAiSnapshot,
  restoreAiSnapshot,
  restoreSnapshot,
  setSlideRenderEnv,
  settleStaleHistoryBatch,
  takeSnapshot,
} from '../domain/session'

export interface RuntimePaths {
  preloadPath: string
  rendererDevUrl?: string | undefined
  rendererFilePath?: string | undefined
}

export const runtime: RuntimePaths = {
  preloadPath: join(__dirname, '../preload/index.js'),
  rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
  rendererFilePath: join(__dirname, '../renderer/index.html'),
}

export function configureSlidesRuntime(paths: RuntimePaths): void {
  runtime.preloadPath = paths.preloadPath
  runtime.rendererDevUrl = paths.rendererDevUrl
  runtime.rendererFilePath = paths.rendererFilePath
}

// One session per renderer process (standalone window or shell tab), keyed by webContents.id
export const sessions = new Map<number, Session>()

// ── Window references (shell tab mode + active renderer tracking) ──────
export const windowRefs = {
  /** Parent window for dialogs in tab mode (the shell's single BrowserWindow) */
  shellWindow: null as BrowserWindow | null,
  /** Currently active slides renderer (window or tab view) — target of menu commands; the shell updates it on tab switch */
  activeWebContents: null as WebContents | null,
}

export function setSlidesShellWindow(win: BrowserWindow | null): void {
  windowRefs.shellWindow = win
}

export function setActiveSlidesWebContents(wc: WebContents | null): void {
  windowRefs.activeWebContents = wc
}

export function dialogParent(): BrowserWindow | undefined {
  return windowRefs.shellWindow ?? BrowserWindow.getFocusedWindow() ?? undefined
}

// ── The host's rendering services ───────────────────────────────────────

/**
 * Precise system-font metrics, built once and shared process-wide.
 *
 * Lazy for the reason it always was: `createSystemFontMetrics` walks the platform's
 * font directories and parses what it finds with opentype.js, which is far too slow
 * to do at import time. Unmatched fonts fall back to heuristics per run.
 */
let systemMetrics: FontMetricsProvider | null = null

function metricsProvider(): FontMetricsProvider {
  return (systemMetrics ??= createSystemFontMetrics())
}

/**
 * Install this host's rendering services into the document session.
 *
 * Called from `registerSlidesIpc`, i.e. once per process, before any deck can be
 * opened. The metrics member forwards rather than being the provider itself, so
 * installing the env stays as cheap as importing this module always was — the font
 * scan happens on the first text measurement, exactly as it did before.
 */
export function installSlidesRenderEnv(): void {
  setSlideRenderEnv({
    metrics: {
      metrics: (style) => metricsProvider().metrics(style),
      measure: (text, style) => metricsProvider().measure(text, style),
      // Optional on the interface, and the fallback has to be the original family:
      // a provider that does not substitute must not be reported as substituting.
      displayFamily: (style, text) =>
        metricsProvider().displayFamily?.(style, text) ?? style.fontFamily,
    },
    decodeTiff: tiffToPng,
  })
}
