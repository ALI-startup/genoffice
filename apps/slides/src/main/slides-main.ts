/**
 * GenOffice Slides main process — pptx parsing/render-tree building/edit application/saving all live
 * here (Node side). The renderer only gets plain-data RenderSlide; edit intents are sent back
 * here to apply. Structure mirrors apps/docs: exports embeddable configure/register/start for
 * future shell reuse.
 */
import {
  clipboard,
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session as electronSession,
  shell,
  WebContentsView,
} from 'electron'
import type { WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile, rm, stat, mkdir, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { gskApiKey, gskSlideGenerate } from '@genoffice/ai-search'
import {
  appMenuLabels,
  contextMenuLabels,
  installContextMenu,
  installNavigationGuard,
  safeExternalUrl,
} from '@genoffice/electron-utils'
import { getUiLang, normalizeLang, setUiLang } from '@genoffice/i18n'
import { ProjectStore } from '@genoffice/project-store'
import {
  addMedia,
  addPicture,
  createBlankPptx,
  deleteSlide,
  type SlideBundle,
  openPptx,
  mergeSlideFromPptx,
  promoteSlideBackground,
  savePptx,
  commitSaved,
  moveSlide,
  type SectionInfo,
  type ElementClipboardItem,
} from '@genoffice/pptx-engine'
// Node-only streaming save; see the subpath's module header.
import { savePptxToFile } from '@genoffice/pptx-engine/node'
import { refineComplexWidths, shapedMetricsReady } from './shaped-metrics'
import { slideOps as ops } from '../domain/ops'
import type { DeckClipboardStore } from '../domain/ops'
// A helper that moved with the operations using it; one host handler still needs it.
import { deckDefaultFont } from '../domain/ops'
import { cfbKind, isCfbHeader } from './cfb-sniff'
import { unplayableAudioCodec } from './mp4-audio-sniff'
import type {
  AddChartOp,
  AddCommentOp,
  AddElementOp,
  AddImageBytesOp,
  AddInkOp,
  AddMediaBytesOp,
  AddBlankSlideOp,
  AddSlideOp,
  PasteSlideOp,
  RepasteSlideOp,
  AddSlideWithLayoutOp,
  AddSmartArtOp,
  AddTableOp,
  ApplyThemeOp,
  HeaderFooterOp,
  SetLinkOp,
  CopyElementsOp,
  DeleteCommentOp,
  DeleteElementOp,
  EditBackgroundOp,
  EditFillOp,
  EditStrokeOp,
  FlipElementOp,
  EditPictureSrcRectOp,
  GroupElementsOp,
  UngroupElementOp,
  BatchEditTransformOp,
  EditTextOp,
  EditTransformOp,
  EditConnectorEndpointsOp,
  SetElementFontOp,
  SetElementParagraphFormatOp,
  FindReplaceOp,
  TableMergeIpcOp,
  SetSlideLayoutOp,
  SetSlideSizeOp,
  MasterEditTextOp,
  MasterEditTransformOp,
  MasterEditFillOp,
  MasterEditStrokeOp,
  MasterDeleteElementOp,
  MasterEnterResult,
  PrintSlidesOp,
  EditPictureOpacityOp,
  ExportImagesOp,
  ExportImagesResult,
  ExportPdfOp,
  ExportPdfResult,
  OpenResult,
  PasteElementsOp,
  DuplicateElementsOp,
  EditTableCellOp,
  EditTableStyleOp,
  EditChartOp,
  SetTableColWidthOp,
  SetTableRowHeightOp,
  SetTableCellAnchorOp,
  TableStructureIpcOp,
  ReorderElementOp,
  SetAdvanceTimesOp,
  SetAnimationsOp,
  SetNotesOp,
  SetSlideHiddenOp,
  SetTransitionOp,
  AddSectionOp,
  RenameSectionOp,
  RemoveSectionOp,
  MoveSectionOp,
  MoveSlideOp,
  AnimationItem,
  ShapeKey,
} from '../shared/ipc'

import { tm } from './i18n-main'
import { tiffToPng } from './tiff-decode'
import {
  buildAllRenderSlides,
  carryHistoryForReplacement,
  dialogParent,
  pushHistory,
  rebuildSlide,
  restoreSnapshot,
  runtime,
  sessions,
  windowRefs,
  type Session,
  installSlidesRenderEnv,
} from './session-state'
import { registerAiIpc, registerSlidesOnlyAiIpc } from './ai-ipc'

/**
 * Last path segment, for the display name the renderer shows.
 *
 * Deriving it is this side's job: the renderer used to `split('/')` a path it was handed,
 * which only works while a `path` happens to be one. A browser's is an opaque store key.
 */
const baseName = (p: string): string => (p ? p.split(/[\\/]/).pop() || '' : '')

/** One slide, copied from any deck open in this process, waiting to be pasted into another. */
let slideClipboard: { bundle: SlideBundle; png?: string } | null = null

/** The immediately preceding slide paste per webContents, so the paste-options floater can redo it with another mode. */
const lastSlidePaste = new Map<number, { afterIndex: number; undoLen: number }>()

// Cloud-generated single-page pptx: marker strings travel in pagesHtml slots; only paths issued
// by slides:cloud-page-generate are readable (the renderer can't point the reader at arbitrary files)
const CLOUD_PAGE_PREFIX = 'cloudpptx:'
const issuedCloudPages = new Set<string>()
import { registerPresenterIpc } from './presenter-show'
import { registerAttachmentIpc } from './attachments-ipc'

export {
  configureSlidesRuntime,
  setActiveSlidesWebContents,
  setSlidesShellWindow,
} from './session-state'
export { registerAiIpc } from './ai-ipc'

/** standalone: path queued before window creation (argv/open-file) */
let pendingOpenPath: string | null = null
/** tab mode: each view queues its own path; the renderer consumes it after mounting */
const pendingByWc = new Map<number, string>()
/**
 * Renderer freeze watchdog: the freeze is sporadic and has never
 * reproduced under instrumentation, so when it does happen, capture the
 * discriminating evidence (per-process CPU/RSS, GPU feature state, and on
 * macOS native thread stacks of the renderer/GPU processes) and give
 * the user a way out. Reload restores from the main-side session, and the
 * 30s recovery draft bounds the loss for a force-quit instead.
 */
const freezeDialogOpen = new Set<number>()

async function handleRendererFreeze(wc: WebContents): Promise<void> {
  const ts = Date.now()
  try {
    const appMetrics = app.getAppMetrics()
    const diagnostics = {
      at: new Date().toISOString(),
      webContentsId: wc.id,
      sessionPath: sessions.get(wc.id)?.path ?? null,
      dirty: slidesIsDirty(wc.id),
      appMetrics,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
    }
    await writeFile(
      join(app.getPath('userData'), `freeze-diagnostics-${ts}.json`),
      JSON.stringify(diagnostics, null, 2),
    )
    // macOS: native thread stacks of the renderer + GPU processes, taken from
    // outside the frozen event loop (task_for_pid based, so it works even when
    // a CDP attach suppresses the hang monitor and Runtime.evaluate is stuck).
    // This is the discriminating evidence for the freeze: a renderer main thread
    // parked in gpu::CommandBufferProxyImpl::WaitFor* confirms the GPU
    // command-buffer-wait hypothesis. Best effort — `sample` is denied for
    // hardened-runtime builds without the get-task-allow entitlement.
    if (process.platform === 'darwin') {
      const gpuPid = appMetrics.find((m) => m.type === 'GPU')?.pid
      const targets: Array<[string, number | undefined]> = [
        ['renderer', wc.getOSProcessId()],
        ['gpu', gpuPid],
      ]
      for (const [label, pid] of targets) {
        if (!pid) continue
        const out = join(app.getPath('userData'), `freeze-stacks-${ts}-${label}-${pid}.txt`)
        // Fire and forget: sampling runs for ~3s and must not delay the dialog
        execFile('/usr/bin/sample', [String(pid), '3', '-file', out], () => {})
      }
    }
  } catch {
    /* diagnostics must never make the freeze worse */
  }
  if (freezeDialogOpen.has(wc.id)) return
  freezeDialogOpen.add(wc.id)
  try {
    const parent = BrowserWindow.fromWebContents(wc)
    const options = {
      type: 'warning' as const,
      message: tm('freezeTitle'),
      detail: tm('freezeBody'),
      buttons: [tm('freezeWait'), tm('freezeReload')],
      defaultId: 0,
      cancelId: 0,
    }
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (response === 1 && !wc.isDestroyed()) {
      wc.forcefullyCrashRenderer()
      wc.reload()
    }
  } finally {
    freezeDialogOpen.delete(wc.id)
  }
}

function trackSlidesWebContents(wc: WebContents): void {
  windowRefs.activeWebContents = wc
  wc.on('unresponsive', () => void handleRendererFreeze(wc))
  // The AI panel opens links via window.open; route them to the system
  // browser instead of spawning an in-app window with remote content.
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  wc.once('destroyed', () => {
    // Untitled recovery draft: cleaned up on a clean close, kept when the session died dirty
    const s = sessions.get(wc.id)
    if (s && !sessionDirty(s)) dropUntitledRecovery(wc.id)
    else untitledRecovery.delete(wc.id)
    sessions.delete(wc.id)
    pendingByWc.delete(wc.id)
    clipboards.delete(wc.id)
    lastSlidePaste.delete(wc.id)
    closeSaveWaiters.get(wc.id)?.(false)
    closeSaveWaiters.delete(wc.id)
    autoSavePrefByWc.delete(wc.id)
    if (windowRefs.activeWebContents === wc) windowRefs.activeWebContents = null
  })
}

// ── In-app element clipboard (isolated per webContents; pasteCount drives cascading offset) ─
const clipboards = new Map<number, { items: ElementClipboardItem[]; pasteCount: number }>()

/** Shell hook: a view opened a file (including ⌘O inside a tab) — used to update tab titles and de-duplicate paths */
let slidesOpenedHook: ((wc: WebContents, path: string) => void) | null = null
export function setSlidesOpenedHook(fn: ((wc: WebContents, path: string) => void) | null): void {
  slidesOpenedHook = fn
}

const RECENT_PATH = () => join(app.getPath('userData'), 'slides-recent.json')

/** Comment author name: system username, falling back to a generic "User" label. */
function commentAuthorName(): string {
  try {
    return userInfo().username || 'User'
  } catch {
    return 'User'
  }
}

async function readRecent(): Promise<string[]> {
  try {
    const raw = await readFile(RECENT_PATH(), 'utf8')
    return (JSON.parse(raw) as string[]).filter((p) => existsSync(p))
  } catch {
    return []
  }
}

async function pushRecent(path: string): Promise<void> {
  const cur = await readRecent()
  const next = [path, ...cur.filter((p) => p !== path)].slice(0, 10)
  try {
    await writeFile(RECENT_PATH(), JSON.stringify(next), 'utf8')
  } catch {
    /* best-effort */
  }
}

/** File renamed externally (shell Home list rename): swap the old path in the recent list for the new one (keeping its position). */
export async function replaceSlidesRecentFile(oldPath: string, newPath: string): Promise<void> {
  try {
    // Do not use readRecent(): it filters out old paths that no longer exist, so the map would miss
    const raw = await readFile(RECENT_PATH(), 'utf8')
    const cur = JSON.parse(raw) as string[]
    await writeFile(
      RECENT_PATH(),
      JSON.stringify(cur.map((p) => (p === oldPath ? newPath : p))),
      'utf8',
    )
  } catch {
    /* best-effort */
  }
}

/** Shell notification: an open view's file was renamed — sync the session path (subsequent
 *  saves write the new file) and push to the renderer to update the editor title bar. */
export function slidesFileRenamed(wc: WebContents, oldPath: string, newPath: string): void {
  const session = sessions.get(wc.id)
  if (session && session.path === oldPath) session.path = newPath
  wc.send('slides:renamed', newPath)
}

// ── Autosave (crash recovery): dirty sessions write a recovery copy every 30s; a normal save cleans it up ──
const autosaveDir = () => join(app.getPath('userData'), 'slides-autosave')
const autosavePathFor = (filePath: string) =>
  join(autosaveDir(), `${createHash('sha1').update(filePath).digest('hex').slice(0, 16)}.pptx`)

function sessionDirty(session: Session): boolean {
  return (
    !!session.metaDirty ||
    session.opened.deck.slides.some(
      (s) => s.structureDirty || s.elements.some((el) => el.dirty || el.dirtyTransform),
    )
  )
}

/**
 * Ticks to skip after a failed recovery copy, per deck. Retrying every 30s just
 * repeats an expensive failure, but disabling the safety net for the rest of the
 * session was worse: on a heavy deck one slow serialization used to remove crash
 * recovery permanently and silently. Back off instead, and keep the
 * skip count so a deck that always fails only pays for it every ~5 minutes.
 */
const autosaveBackoff = new Map<string, number>()
const AUTOSAVE_BACKOFF_TICKS = 10
let autosaveRunning = false

/**
 * Recovery drafts for never-saved decks (wcId → visible path in <Documents>/GenOffice):
 * the sha1-keyed recovery copy needs session.path, so before the first save a freeze or
 * crash used to lose everything. Removed on save, explicit discard, or clean close.
 */
const untitledRecovery = new Map<number, string>()

function dropUntitledRecovery(wcId: number): void {
  const draft = untitledRecovery.get(wcId)
  if (draft) void rm(draft, { force: true }).catch(() => {})
  untitledRecovery.delete(wcId)
}

setInterval(() => {
  if (autosaveRunning) return
  autosaveRunning = true
  void (async () => {
    for (const [wcId, session] of sessions.entries()) {
      if (session.masterEdit || !sessionDirty(session)) continue
      let target: string
      if (session.path) {
        target = autosavePathFor(session.path)
      } else {
        let draft = untitledRecovery.get(wcId)
        if (!draft) {
          draft = join(getDraftsDir(), newDraftFilename())
          untitledRecovery.set(wcId, draft)
        }
        target = draft
      }
      const backoffKey = session.path ?? target
      const skip = autosaveBackoff.get(backoffKey) ?? 0
      if (skip > 0) {
        autosaveBackoff.set(backoffKey, skip - 1)
        continue
      }
      try {
        await mkdir(dirname(target), { recursive: true })
        await savePptxToFile(session.opened, target)
        autosaveBackoff.delete(backoffKey)
      } catch (error) {
        autosaveBackoff.set(backoffKey, AUTOSAVE_BACKOFF_TICKS)
        console.warn('[slides] autosave failed, retrying in ~5 min:', error)
      }
    }
  })().finally(() => {
    autosaveRunning = false
  })
}, 30_000)

// ── Close guard (aligned with sheets/pdf): dirty sessions prompt Save/Don't Save/Cancel before closing a tab/window ──
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
/** Autosave toggle mirrored from the renderer: files with it on save silently on close and proceed, no dialog */
const autoSavePrefByWc = new Map<number, boolean>()

ipcMain.on('slides:autosave-pref', (event, on: unknown) => {
  autoSavePrefByWc.set(event.sender.id, on === true)
})

ipcMain.on('slides:close-save-result', (event, ok: unknown) => {
  const waiter = closeSaveWaiters.get(event.sender.id)
  if (!waiter) return
  closeSaveWaiters.delete(event.sender.id)
  waiter(ok === true)
})

/** Ask the renderer to run the full save flow and await the result (failure/timeout = false). */
function requestRendererSave(contents: WebContents): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      closeSaveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    closeSaveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send('slides:close-save-request')
  })
}

export function slidesIsDirty(webContentsId: number): boolean {
  const session = sessions.get(webContentsId)
  return !!session && sessionDirty(session)
}

/**
 * Close guard for the slides renderer: true means proceed with closing.
 * Clean -> true; with changes -> Save/Don't Save/Cancel. Choosing Save asks the renderer to run
 * the existing save flow (flushNotes + adoptSavedSlides + Save As dialog for untitled) and
 * awaits the result; on failure/timeout stay open.
 */
export async function requestSlidesClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  if (!slidesIsDirty(contents.id) || contents.isDestroyed()) return true
  // Autosave on and a path exists: save silently and proceed without bothering the user; only a failed save falls through to the dialog
  if (autoSavePrefByWc.get(contents.id) && sessions.get(contents.id)?.path) {
    if (await requestRendererSave(contents)) return true
  }
  const options = {
    type: 'warning' as const,
    message: tm('closeUnsavedMsg'),
    detail: tm('closeUnsavedDetail'),
    buttons: [tm('menuSave'), tm('btnDontSave'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (response === 2) return false
  if (response === 1) {
    // User explicitly discarded changes: also delete the recovery copy, so the next open does not show a pointless recovery prompt
    const session = sessions.get(contents.id)
    if (session?.path) void rm(autosavePathFor(session.path), { force: true }).catch(() => {})
    dropUntitledRecovery(contents.id)
    return true
  }
  return requestRendererSave(contents)
}

/** On open, if a recovery copy newer than the original exists, ask whether to restore (still points at the original path; only save persists it). */
async function maybeRecoverBytes(
  path: string,
  original: Uint8Array,
): Promise<{ bytes: Uint8Array; recovered: boolean }> {
  const asPath = autosavePathFor(path)
  try {
    const [asStat, origStat] = await Promise.all([stat(asPath), stat(path)])
    if (asStat.mtimeMs <= origStat.mtimeMs) {
      await rm(asPath, { force: true })
      return { bytes: original, recovered: false }
    }
  } catch {
    return { bytes: original, recovered: false }
  }
  const parent = dialogParent()
  const options = {
    type: 'question' as const,
    buttons: [tm('autosaveRestore'), tm('autosaveDiscard')],
    defaultId: 0,
    cancelId: 1,
    message: tm('autosaveFoundTitle'),
    detail: tm('autosaveFoundBody'),
  }
  const r = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  if (r.response === 0) {
    const bytes = await readFile(asPath)
    return { bytes: new Uint8Array(bytes), recovered: true }
  }
  await rm(asPath, { force: true })
  return { bytes: original, recovered: false }
}

/**
 * .ppt (97-2003 binary compound document) and encrypted OOXML are unsupported: show an actionable message instead of a parse error.
 * Detection uses the magic number rather than the extension -- a binary ppt with a renamed suffix is caught too. A CFB containing an
 * EncryptedPackage stream is a password-protected pptx and gets dedicated copy (instead of being mislabeled as the legacy format).
 */
async function rejectLegacyPpt(path: string): Promise<boolean> {
  let head: Buffer
  try {
    const fh = await open(path, 'r')
    try {
      head = Buffer.alloc(8)
      await fh.read(head, 0, 8, 0)
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
  if (!isCfbHeader(head)) return false
  let kind: 'legacy' | 'encrypted' = 'legacy'
  try {
    kind = cfbKind(await readFile(path)) ?? 'legacy'
  } catch {
    // on read failure, fall back to the legacy-format message
  }
  const parent = dialogParent()
  const options = {
    type: 'warning' as const,
    buttons: [tm('legacyPptOk')],
    message: tm(kind === 'encrypted' ? 'encryptedPptxTitle' : 'legacyPptTitle'),
    detail: tm(kind === 'encrypted' ? 'encryptedPptxBody' : 'legacyPptBody'),
  }
  if (parent) await dialog.showMessageBox(parent, options)
  else await dialog.showMessageBox(options)
  return true
}

async function openAndBuild(
  wc: WebContents,
  path: string,
  fitWidthPx: number,
): Promise<OpenResult> {
  const raw = await readFile(path)
  const { bytes, recovered } = await maybeRecoverBytes(path, new Uint8Array(raw))
  await shapedMetricsReady() // Lay out only after complex-script shaped metrics are ready, avoiding an init race falling back to estimation
  const opened = await openPptx(bytes)
  sessions.set(wc.id, {
    path,
    opened,
    fitWidthPx,
    undoStack: [],
    redoStack: [],
    ...(recovered ? { metaDirty: true } : {}),
  })
  await pushRecent(path)
  slidesOpenedHook?.(wc, path)
  let slides = buildAllRenderSlides(opened, fitWidthPx)
  // If the first layout pass had complex-script misses (Arabic/Thai etc.), re-lay out once with renderer-measured widths
  if (await refineComplexWidths(wc)) slides = buildAllRenderSlides(opened, fitWidthPx)
  return {
    path,
    name: baseName(path),
    slides,
    size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
    defaultFont: deckDefaultFont(opened),
  }
}

/** Directory where AI-generated drafts are saved: <Documents>/GenOffice/ */
function getDraftsDir(): string {
  return join(app.getPath('documents'), 'GenOffice')
}

/** Fallback draft filename: <untitled label>-YYYYMMDD-HHmmss.pptx */
function newDraftFilename(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${tm('untitledDraft')}-${date}-${time}.pptx`
}

/** Sanitize an AI-provided topic/title into a safe filename base: strip illegal path chars, collapse whitespace, cap length; null if invalid. */
function sanitizeDraftBaseName(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Strip leading/trailing dots (Windows disallows a trailing dot; a hidden-file prefix is meaningless here)
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned
}

/** Pick a draft path from deckName: append -2/-3… if a same-named file exists; fall back to timestamp naming without a valid deckName. */
function pickDraftPath(draftsDir: string, deckName?: string): string {
  const base = sanitizeDraftBaseName(deckName)
  if (base) {
    let candidate = join(draftsDir, `${base}.pptx`)
    for (let i = 2; existsSync(candidate) && i < 100; i++) {
      candidate = join(draftsDir, `${base}-${i}.pptx`)
    }
    if (!existsSync(candidate)) return candidate
  }
  return join(draftsDir, newDraftFilename())
}

/**
 * Auto-save the draft to <Documents>/GenOffice/<name>.pptx after AI generation completes.
 * Append mode reuses the session's existing draft path (overwrite); replace mode generates a
 * new filename. On successful write, update session.path, pushRecent, slidesOpenedHook.
 * On write failure, degrade silently (console.warn) without blocking the in-memory session.
 */
async function saveDraftAfterGenerate(
  wc: WebContents,
  session: Session,
  bytes: Uint8Array,
  mode: 'replace' | 'append',
  deckName?: string,
): Promise<void> {
  try {
    const draftsDir = getDraftsDir()
    // Ensure the directory exists
    if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true })

    // Append mode: overwrite if the session already has a draft path; otherwise create a new file too
    let draftPath: string
    if (mode === 'append' && session.path && session.path.startsWith(draftsDir)) {
      draftPath = session.path
    } else {
      draftPath = pickDraftPath(draftsDir, deckName)
    }

    await writeFile(draftPath, Buffer.from(bytes))
    session.path = draftPath
    await pushRecent(draftPath)
    slidesOpenedHook?.(wc, draftPath)
  } catch (err) {
    console.warn(
      '[slides] Failed to persist AI-generated draft to disk; the in-memory session still works:',
      err,
    )
  }
}

let ipcRegistered = false

export function registerSlidesIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  // The document session is host-neutral (src/domain/session.ts); this is where this
  // host hands it the two things it cannot supply itself — real system-font metrics
  // and a TIFF decoder. Before any deck can be opened, and once per process.
  installSlidesRenderEnv()

  // shared with the other editor modules — last (identical) registration wins
  ipcMain.removeHandler('app:get-language')
  ipcMain.handle('app:get-language', () => getUiLang())

  // Screen recording: source dispatch for the renderer's navigator.mediaDevices.getDisplayMedia.
  // macOS prefers the system picker (with its permission flow), falling back to the first screen.
  void app.whenReady().then(() => {
    try {
      electronSession.defaultSession.setDisplayMediaRequestHandler(
        (_request, callback) => {
          desktopCapturer
            .getSources({ types: ['screen', 'window'] })
            .then((sources) => {
              if (sources[0]) callback({ video: sources[0] })
              else callback({})
            })
            .catch(() => callback({}))
        },
        { useSystemPicker: true },
      )
    } catch {
      /* Older Electron lacks this API: the screen-record button will get no stream and report failure */
    }
  })

  ipcMain.handle('slides:open', async (e, fitWidthPx: number) => {
    const parent = dialogParent()
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }],
    }
    const r = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return null
    if (await rejectLegacyPpt(r.filePaths[0])) return null
    return openAndBuild(e.sender, r.filePaths[0], fitWidthPx)
  })

  ipcMain.handle('slides:open-path', async (e, path: string, fitWidthPx: number) => {
    if (!path || !existsSync(path)) return null
    if (await rejectLegacyPpt(path)) return null
    return openAndBuild(e.sender, path, fitWidthPx)
  })

  ipcMain.handle('slides:consume-pending-open', async (e, fitWidthPx: number) => {
    // renderer app just mounted: safe to reveal the vibrancy material behind
    // the (now painted) page without flashing raw desktop during load
    vibFlip.get(e.sender.id)?.('#00000000')
    const queued = pendingByWc.get(e.sender.id) ?? pendingOpenPath
    if (queued && existsSync(queued)) {
      // Clear the queue only after a successful open: keep it on parse failure or a mid-flight renderer reload, so a remount can retry
      const result = await openAndBuild(e.sender, queued, fitWidthPx)
      if (pendingByWc.get(e.sender.id) === queued) pendingByWc.delete(e.sender.id)
      if (pendingOpenPath === queued) pendingOpenPath = null
      return result
    }
    // No queued path but the main process already has a session (remount after an HMR full
    // reload/crash recovery) -> restore from the session; otherwise the document is lost leaving
    // only the start screen, and reopening the same file just activates this empty tab with no
    // way to self-heal
    const session = sessions.get(e.sender.id)
    if (session) {
      session.fitWidthPx = fitWidthPx
      return {
        path: session.path,
        name: baseName(session.path),
        slides: buildAllRenderSlides(session.opened, fitWidthPx),
        size: { cx: session.opened.deck.size.cx, cy: session.opened.deck.size.cy },
        defaultFont: deckDefaultFont(session.opened),
      } satisfies OpenResult
    }
    return null
  })

  ipcMain.handle('slides:edit-text', (e, op: EditTextOp) =>
    ops.editText(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-element-font', (e, op: SetElementFontOp) =>
    ops.setElementFont(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-element-paragraph-format', (e, op: SetElementParagraphFormatOp) =>
    ops.setElementParagraphFormat(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:edit-transform', (e, op: EditTransformOp) =>
    ops.editTransform(sessions.get(e.sender.id), op),
  )

  // Connector endpoint drag: box+flip re-derived from the two endpoints;
  // attach/detach writes a:stCxn/a:endCxn so the connector follows later shape moves
  ipcMain.handle('slides:edit-connector-endpoints', (e, op: EditConnectorEndpointsOp) =>
    ops.editConnectorEndpoints(sessions.get(e.sender.id), op),
  )

  // Read-only: RenderSlide for every page of the current session (E2E driver/debug use, no state change)
  ipcMain.handle('slides:get-render-slides', (e) => ops.getRenderSlides(sessions.get(e.sender.id)))

  ipcMain.handle('slides:batch-edit-transform', (e, op: BatchEditTransformOp) =>
    ops.batchEditTransform(sessions.get(e.sender.id), op),
  )
  // ── Cloud single-page generation (gsk slide_generate): brief → cloud HTML+conversion → one-slide
  // pptx saved to a temp file. Returns a marker string that flows through the same pagesHtml slots
  // as locally generated HTML; slides:html-to-pptx recognizes it and reads the bytes instead of
  // converting. Enabled when gsk is logged in; GENOFFICE_CLOUD_SLIDE=0 is the kill switch.
  const cloudSlideEnabled = () => process.env.GENOFFICE_CLOUD_SLIDE !== '0' && !!gskApiKey()

  ipcMain.handle('slides:cloud-gen-status', () => ({ enabled: cloudSlideEnabled() }))

  ipcMain.handle(
    'slides:cloud-page-generate',
    async (
      _e,
      op: {
        brief: string
        title?: string
        styleSkill?: string
        deckContext?: Record<string, unknown>
        images?: { url: string; caption?: string }[]
        width?: number
        height?: number
      },
    ): Promise<{ ok: boolean; marker?: string; error?: string }> => {
      if (!cloudSlideEnabled()) return { ok: false, error: 'cloud slide generation is disabled' }
      try {
        // ultra = opus-class model, matching the local path's quality tier; GENOFFICE_CLOUD_SLIDE_TIER=standard opts down
        const tier = process.env.GENOFFICE_CLOUD_SLIDE_TIER === 'standard' ? 'standard' : 'ultra'
        const started = Date.now()
        const { bytes, model } = await gskSlideGenerate({
          tier,
          brief: String(op.brief ?? ''),
          title: op.title ? String(op.title) : undefined,
          styleSkill: op.styleSkill ? String(op.styleSkill) : undefined,
          deckContext: op.deckContext,
          images: Array.isArray(op.images) ? op.images : undefined,
          width: op.width,
          height: op.height,
        })
        console.log(
          `[cloud-slide] page generated: tier=${tier} model=${model} bytes=${bytes.length} ms=${Date.now() - started}`,
        )
        const dir = join(app.getPath('temp'), 'genoffice-cloud-pages')
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `${randomUUID()}.pptx`)
        await writeFile(path, bytes)
        issuedCloudPages.add(path)
        return { ok: true, marker: CLOUD_PAGE_PREFIX + path }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    'slides:html-to-pptx',
    async (
      e,
      pagesHtml: string[],
      fitWidthPx: number,
      mode?: 'replace' | 'append' | 'replace_at' | 'insert_at',
      atIndex?: number,
      deckName?: string,
    ): Promise<
      | (OpenResult & {
          appendedFrom?: number
          replacedIndex?: number
          insertedIndex?: number
          fallbackReason?: string
          imageFailures?: { page: number; url: string }[]
        })
      | { error: string }
    > => {
      // Every page arrives as a cloud marker (cloudpptx:<path> written by
      // slides:cloud-page-generate, pointing at a one-slide pptx temp file); this handler only
      // reads and lands the bytes.
      // replace: assemble the whole batch into one multi-page pptx as the new deck base.
      // append: merge the "new pages" one by one into the existing deck via mergeSlideFromPptx
      // (earlier pages are untouched).
      const readCloudPage = async (marker: string): Promise<{ bytes: Uint8Array }> => {
        if (!marker.startsWith(CLOUD_PAGE_PREFIX)) throw new Error('expected a cloud page marker')
        const path = marker.slice(CLOUD_PAGE_PREFIX.length)
        if (!issuedCloudPages.has(path)) throw new Error('unknown cloud page marker')
        return { bytes: new Uint8Array(await readFile(path)) }
      }
      const assembleDeck = async (): Promise<{ bytes: Uint8Array }> => {
        const perPage = await Promise.all(pagesHtml.map(readCloudPage))
        const base = await openPptx(perPage[0]!.bytes)
        for (const one of perPage.slice(1)) await mergeSlideFromPptx(base, one.bytes)
        for (const s of base.deck.slides) promoteSlideBackground(s, base.deck.size)
        return { bytes: await savePptx(base) }
      }

      try {
        // Append: convert only the "new pages" and merge them one by one into the existing
        // in-memory deck via mergeSlideFromPptx. Already-landed pages stay untouched
        // (O(N) rather than O(N²)); no dependency on stored PageVisualData.
        if (mode === 'append') {
          const existing = sessions.get(e.sender.id)
          if (!existing) {
            return { error: tm('errNoDeckAppend') }
          }
          const opened = existing.opened
          const beforeCount = opened.deck.slides.length
          // Push an undo snapshot: appending is an ordinary edit, ⌘Z should return to the
          // pre-append state (previously the undoStack was simply cleared, making all of the
          // user's prior manual edits non-undoable — inconsistent with replace_at behavior)
          pushHistory(existing)
          let merged = 0
          let lastErr: string | undefined
          for (const html of pagesHtml) {
            try {
              const one = await readCloudPage(html)
              const slide = await mergeSlideFromPptx(opened, one.bytes)
              if (slide) {
                promoteSlideBackground(slide, opened.deck.size)
                merged += 1
              } else lastErr = tm('errMergeFailed')
            } catch (pageErr) {
              lastErr = pageErr instanceof Error ? pageErr.message : String(pageErr)
            }
          }
          if (merged === 0) {
            existing.undoStack.pop() // Nothing happened, pop the just-pushed snapshot
            return { error: tm('errAppendFailed', { reason: lastErr ?? tm('errUnknown') }) }
          }
          existing.fitWidthPx = fitWidthPx
          // Save the draft: persist the current complete deck
          const bytes = await savePptx(opened)
          await saveDraftAfterGenerate(e.sender, existing, bytes, 'append', deckName)
          // Draft now matches memory: reopen from the output bytes to clear dirty (same as
          // slides:save) — otherwise pure AI generation (per-page append merges mark
          // structureDirty) would trigger the close confirmation even without edits
          if (existing.path) {
            existing.opened = await openPptx(bytes)
            existing.metaDirty = false
          }
          return {
            path: existing.path,
            name: baseName(existing.path),
            slides: buildAllRenderSlides(existing.opened, fitWidthPx),
            size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
            defaultFont: deckDefaultFont(existing.opened),
            appendedFrom: beforeCount,
            ...(lastErr && merged < pagesHtml.length
              ? { fallbackReason: tm('errPartialAppend', { reason: lastErr }) }
              : {}),
          }
        }

        // Redo one page in place: single-page HTML -> single-page pptx -> merge at the end ->
        // moveSlide into position -> delete the old page. Conversion happens first (deck
        // untouched); the mutation phase takes one undo snapshot overall, so ⌘Z rolls back to the
        // old page.
        if (mode === 'replace_at') {
          const existing = sessions.get(e.sender.id)
          if (!existing) {
            return { error: tm('errNoDeckReplace') }
          }
          const opened = existing.opened
          const total = opened.deck.slides.length
          if (atIndex == null || !Number.isInteger(atIndex) || atIndex < 0 || atIndex >= total) {
            return { error: tm('errIndexRange', { max: total - 1 }) }
          }
          const html = pagesHtml[0]
          if (!html || pagesHtml.length !== 1) {
            return { error: tm('errReplaceNeedsOne') }
          }
          const one = await readCloudPage(html)
          pushHistory(existing)
          const rollback = () => {
            const snap = existing.undoStack.pop()
            if (snap) restoreSnapshot(existing, snap)
          }
          const merged = await mergeSlideFromPptx(opened, one.bytes)
          if (!merged) {
            rollback()
            return { error: tm('errMergeFailed') }
          }
          promoteSlideBackground(merged, opened.deck.size)
          // The new page is at the end (index=total); after moving to atIndex the old page gets pushed to atIndex+1, delete it
          if (!moveSlide(opened, total, atIndex) || !deleteSlide(opened, atIndex + 1)) {
            rollback()
            return { error: tm('errReplaceFailed') }
          }
          existing.fitWidthPx = fitWidthPx
          const bytes = await savePptx(opened)
          await saveDraftAfterGenerate(e.sender, existing, bytes, 'append', deckName)
          if (existing.path) {
            existing.opened = await openPptx(bytes)
            existing.metaDirty = false
          }
          return {
            path: existing.path,
            name: baseName(existing.path),
            slides: buildAllRenderSlides(existing.opened, fitWidthPx),
            size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
            defaultFont: deckDefaultFont(existing.opened),
            replacedIndex: atIndex,
          }
        }

        // Insert one page at atIndex (later pages shift back): used to regenerate a failed middle
        // page from generate_deck and put it back in place. Same mechanism as replace_at (merge at
        // the end -> moveSlide into position) but without deleting an old page.
        if (mode === 'insert_at') {
          const existing = sessions.get(e.sender.id)
          if (!existing) {
            return { error: tm('errNoDeckInsert') }
          }
          const opened = existing.opened
          const total = opened.deck.slides.length
          if (atIndex == null || !Number.isInteger(atIndex) || atIndex < 0 || atIndex > total) {
            return { error: tm('errIndexRange', { max: total }) }
          }
          const html = pagesHtml[0]
          if (!html || pagesHtml.length !== 1) {
            return { error: tm('errInsertNeedsOne') }
          }
          const one = await readCloudPage(html)
          pushHistory(existing)
          const rollback = () => {
            const snap = existing.undoStack.pop()
            if (snap) restoreSnapshot(existing, snap)
          }
          const merged = await mergeSlideFromPptx(opened, one.bytes)
          if (!merged) {
            rollback()
            return { error: tm('errMergeFailed') }
          }
          promoteSlideBackground(merged, opened.deck.size)
          // The new page is at the end (index=total); with atIndex=total it belongs at the end anyway, no move needed
          if (atIndex < total && !moveSlide(opened, total, atIndex)) {
            rollback()
            return { error: tm('errInsertFailed') }
          }
          existing.fitWidthPx = fitWidthPx
          const bytes = await savePptx(opened)
          await saveDraftAfterGenerate(e.sender, existing, bytes, 'append', deckName)
          if (existing.path) {
            existing.opened = await openPptx(bytes)
            existing.metaDirty = false
          }
          return {
            path: existing.path,
            name: baseName(existing.path),
            slides: buildAllRenderSlides(existing.opened, fitWidthPx),
            size: { cx: existing.opened.deck.size.cx, cy: existing.opened.deck.size.cy },
            defaultFont: deckDefaultFont(existing.opened),
            insertedIndex: atIndex,
          }
        }

        // replace mode: assemble the whole batch into one multi-page pptx as the new deck base.
        const { bytes } = await assembleDeck()
        const opened = await openPptx(bytes)
        // With per-page conversion + merging, stored PageVisualData is no longer needed; append reads the opened deck directly.
        const replaceSession: Session = {
          path: '',
          opened,
          fitWidthPx,
          undoStack: [],
          redoStack: [],
          htmlPages: null,
        }
        carryHistoryForReplacement(sessions.get(e.sender.id), replaceSession)
        sessions.set(e.sender.id, replaceSession)
        // Save the draft: await completion so the real path is returned; on failure degrade silently (session.path stays '')
        await saveDraftAfterGenerate(e.sender, replaceSession, bytes, 'replace', deckName)
        return {
          path: replaceSession.path,
          name: baseName(replaceSession.path),
          slides: buildAllRenderSlides(opened, fitWidthPx),
          size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
          defaultFont: deckDefaultFont(opened),
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('slides:new-blank', async (e, fitWidthPx: number): Promise<OpenResult> => {
    const opened = await openPptx(await createBlankPptx())
    sessions.set(e.sender.id, { path: '', opened, fitWidthPx, undoStack: [], redoStack: [] })
    return {
      path: '',
      name: baseName(''),
      slides: buildAllRenderSlides(opened, fitWidthPx),
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  })

  ipcMain.handle('slides:add-element', (e, op: AddElementOp) =>
    ops.addElement(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:delete-element', (e, op: DeleteElementOp) =>
    ops.deleteElement(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:edit-stroke', (e, op: EditStrokeOp) =>
    ops.editStroke(sessions.get(e.sender.id), op),
  )

  // Mirror elements across their own axis: flipH/flipV is the only way to
  // point an arrow the other way — rotation cannot express a single-axis mirror
  ipcMain.handle('slides:flip-elements', (e, op: FlipElementOp) =>
    ops.flipElements(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:edit-picture-src-rect', (e, op: EditPictureSrcRectOp) =>
    ops.editPictureSrcRect(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:group-elements', (e, op: GroupElementsOp) =>
    ops.groupElements(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:ungroup-element', (e, op: UngroupElementOp) =>
    ops.ungroupElement(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:edit-background', (e, op: EditBackgroundOp) =>
    ops.editBackground(sessions.get(e.sender.id), op),
  )

  ipcMain.handle(
    'slides:edit-image-fill',
    async (e, op: { slideIndex: number; sourceId: string }) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      const parent = dialogParent()
      const options = {
        title: tm('dlgInsertImage'),
        properties: ['openFile' as const],
        filters: [
          {
            name: tm('filterImages'),
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
          },
        ],
      }
      const r = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (r.canceled || !r.filePaths[0]) return null
      const bytes = await readFile(r.filePaths[0])
      const ext = r.filePaths[0].split('.').pop()!.toLowerCase()
      return ops.setImageFillBytes(session, {
        slideIndex: op.slideIndex,
        sourceId: op.sourceId,
        bytes,
        ext,
      })
    },
  )

  ipcMain.handle('slides:insert-image', async (e, slideIndex: number, fitWidthPx: number) => {
    const session = sessions.get(e.sender.id)
    if (!session) return null
    const slide = session.opened.deck.slides[slideIndex]
    if (!slide) return null
    const parent = dialogParent()
    const options = {
      title: tm('dlgInsertImage'),
      properties: ['openFile' as const],
      filters: [
        {
          name: tm('filterImages'),
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
        },
      ],
    }
    const r = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return null
    const filePath = r.filePaths[0]
    const bytes = await readFile(filePath)
    const ext = filePath.split('.').pop()!.toLowerCase()

    // Scale proportionally to at most half the page width/height, centered
    const deckSize = session.opened.deck.size
    let natural = { width: 4, height: 3 }
    if (ext === 'tif' || ext === 'tiff') {
      const decoded = tiffToPng(new Uint8Array(bytes))
      if (decoded) natural = { width: decoded.width, height: decoded.height }
    } else {
      const img = nativeImage.createFromPath(filePath)
      if (!img.isEmpty()) natural = img.getSize()
    }
    const maxW = deckSize.cx / 2
    const maxH = deckSize.cy / 2
    const scale = Math.min(maxW / natural.width, maxH / natural.height)
    const cx = Math.round(natural.width * scale)
    const cy = Math.round(natural.height * scale)
    const offset = {
      x: Math.round((deckSize.cx - cx) / 2),
      y: Math.round((deckSize.cy - cy) / 2),
      cx,
      cy,
    }

    pushHistory(session)
    const el = addPicture(session.opened, slide, { bytes: new Uint8Array(bytes), ext, offset })
    if (!el) {
      session.undoStack.pop()
      return { error: 'unsupported' as const, ext }
    }
    session.fitWidthPx = fitWidthPx
    const rebuilt = rebuildSlide(session, slideIndex)
    return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
  })

  ipcMain.handle('slides:edit-fill', (e, op: EditFillOp) =>
    ops.editFill(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:add-slide', (e, op: AddSlideOp) =>
    ops.addSlide(sessions.get(e.sender.id), op),
  )

  // App-wide, so a slide copied in one tab can be pasted into another deck.

  /**
   * This host's clipboard storage, handed to the operations that use it.
   *
   * Deliberately not one object: the copied *slide* is process-global so it can be pasted
   * into a deck open in another window, while the element clipboard and the last-paste
   * record are per renderer. That asymmetry is the desktop's behaviour and is preserved
   * exactly — a browser's store is page-local for all three, which is a narrower promise
   * it makes honestly.
   */
  const deckClipboardFor = (wcId: number): DeckClipboardStore => ({
    slide: () => slideClipboard,
    setSlide: (entry) => {
      slideClipboard = entry
    },
    elements: () => clipboards.get(wcId) ?? null,
    setElements: (entry) => {
      if (entry) clipboards.set(wcId, entry)
      else clipboards.delete(wcId)
    },
    lastPaste: () => lastSlidePaste.get(wcId) ?? null,
    setLastPaste: (record) => {
      if (record) lastSlidePaste.set(wcId, record)
      else lastSlidePaste.delete(wcId)
    },
    // The system-clipboard marker: an external copy overwrites it, so at paste time it tells
    // whether this app or another application copied most recently.
    markCopied: (kind) =>
      clipboard.writeBuffer(
        `io.genoffice.slides.${kind === 'slide' ? 'slide' : 'elements'}`,
        Buffer.from('1'),
      ),
  })

  ipcMain.handle('slides:copy-slide', (e, slideIndex: number, pngBase64?: string) =>
    ops.copySlide(sessions.get(e.sender.id), slideIndex, pngBase64, deckClipboardFor(e.sender.id)),
  )

  ipcMain.handle('slides:has-slide-clipboard', () => slideClipboard !== null)

  ipcMain.handle('slides:paste-slide', (e, op: PasteSlideOp) =>
    ops.pasteSlide(sessions.get(e.sender.id), op, deckClipboardFor(e.sender.id)),
  )

  ipcMain.handle('slides:repaste-slide', (e, op: RepasteSlideOp) =>
    ops.repasteSlide(sessions.get(e.sender.id), op, deckClipboardFor(e.sender.id)),
  )

  ipcMain.handle('slides:copy-elements', (e, op: CopyElementsOp) =>
    ops.copyElements(sessions.get(e.sender.id), op, deckClipboardFor(e.sender.id)),
  )

  ipcMain.handle('slides:paste-elements', (e, op: PasteElementsOp) =>
    ops.pasteElements(sessions.get(e.sender.id), op, deckClipboardFor(e.sender.id)),
  )

  // Paste-options floater: undo the just-completed paste and redo it with another
  // mode. Refused when anything (edits, ⌘Z) touched the deck in between.

  ipcMain.handle('slides:add-blank-slide', (e, op: AddBlankSlideOp) =>
    ops.addBlankSlide(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:add-slide-with-layout', (e, op: AddSlideWithLayoutOp) =>
    ops.addSlideWithLayout(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:get-layouts', (e) => ops.getLayouts(sessions.get(e.sender.id)))

  ipcMain.handle('slides:master-enter', (e, fitWidthPx: number): MasterEnterResult | null =>
    ops.masterEnter(sessions.get(e.sender.id), fitWidthPx),
  )

  ipcMain.handle('slides:master-open', (e, partPath: string) =>
    ops.masterOpen(sessions.get(e.sender.id), partPath),
  )

  ipcMain.handle('slides:master-close', (e) => ops.masterClose(sessions.get(e.sender.id)))

  ipcMain.handle('slides:master-edit-text', (e, op: MasterEditTextOp) =>
    ops.masterEditText(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:master-edit-transform', (e, op: MasterEditTransformOp) =>
    ops.masterEditTransform(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:master-edit-fill', (e, op: MasterEditFillOp) =>
    ops.masterEditFill(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:master-edit-stroke', (e, op: MasterEditStrokeOp) =>
    ops.masterEditStroke(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:master-delete-element', (e, op: MasterDeleteElementOp) =>
    ops.masterDeleteElement(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:edit-picture-opacity', (e, op: EditPictureOpacityOp) =>
    ops.editPictureOpacity(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-slide-size', (e, op: SetSlideSizeOp) =>
    ops.setSlideSize(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:get-slide-size', (e) => ops.getSlideSize(sessions.get(e.sender.id)))

  ipcMain.handle('slides:set-slide-layout', (e, op: SetSlideLayoutOp) =>
    ops.setSlideLayout(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:find-replace', (e, op: FindReplaceOp) =>
    ops.findReplace(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:delete-slide', (e, slideIndex: number) =>
    ops.deleteSlide(sessions.get(e.sender.id), slideIndex),
  )

  ipcMain.handle('slides:edit-table-cell', (e, op: EditTableCellOp) =>
    ops.editTableCell(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:table-merge', (e, op: TableMergeIpcOp) =>
    ops.tableMerge(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:table-structure', (e, op: TableStructureIpcOp) =>
    ops.tableStructure(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-table-row-height', (e, op: SetTableRowHeightOp) =>
    ops.setTableRowHeight(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-table-cell-anchor', (e, op: SetTableCellAnchorOp) =>
    ops.setTableCellAnchor(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-table-col-width', (e, op: SetTableColWidthOp) =>
    ops.setTableColWidth(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:edit-table-style', (e, op: EditTableStyleOp) =>
    ops.editTableStyle(sessions.get(e.sender.id), op),
  )

  // The confirmation this passes is the host's: a native warning box here, and whatever a
  // browser can show there. The decision it reports — proceed or not — is the only thing
  // the operation needs, so the operation itself stays host-neutral.
  const confirmChartSimplify = async (): Promise<boolean> => {
    const parent = dialogParent()
    const options = {
      type: 'warning' as const,
      buttons: [tm('chartSimplifyOk'), tm('btnCancel')],
      defaultId: 0,
      cancelId: 1,
      message: tm('chartSimplifyTitle'),
      detail: tm('chartSimplifyBody'),
    }
    const r = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return r.response === 0
  }

  ipcMain.handle('slides:edit-chart', async (e, op: EditChartOp) =>
    ops.editChart(sessions.get(e.sender.id), op, confirmChartSimplify, tm),
  )

  ipcMain.handle('slides:chart-color-schemes', (e) =>
    ops.chartColorSchemes(sessions.get(e.sender.id), tm),
  )

  ipcMain.handle('slides:get-chart-data', (e, slideIndex: number, sourceId: string) =>
    ops.getChartData(sessions.get(e.sender.id), slideIndex, sourceId),
  )

  ipcMain.handle('slides:reorder-element', (e, op: ReorderElementOp) =>
    ops.reorderElement(sessions.get(e.sender.id), op),
  )

  ipcMain.handle(
    'slides:set-text-anchor',
    (e, op: { slideIndex: number; sourceId: string; anchor: 'top' | 'middle' | 'bottom' }) =>
      ops.setTextAnchor(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:clipboard-external', () => {
    // Our marker still present = the last copy came from this app -> use internal element paste
    // (on macOS custom formats don't appear in availableFormats, so check via readBuffer)
    const marker = (format: string) => {
      try {
        return clipboard.readBuffer(format).length > 0
      } catch {
        return false
      }
    }
    if (slideClipboard && marker('io.genoffice.slides.slide')) return { kind: 'slide' }
    if (marker('io.genoffice.slides.elements')) return { kind: 'internal' }
    const img = clipboard.readImage()
    if (!img.isEmpty()) return { kind: 'image', base64: img.toPNG().toString('base64'), ext: 'png' }
    const text = clipboard.readText()
    if (text.trim()) return { kind: 'text', text }
    return { kind: 'none' }
  })

  // Duplicate in place (⌘D / Option+drag copy): does not touch the app clipboard; the caller supplies the offset
  ipcMain.handle('slides:duplicate-elements', (e, op: DuplicateElementsOp) =>
    ops.duplicateElements(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:add-table', (e, op: AddTableOp) =>
    ops.addTable(sessions.get(e.sender.id), op),
  )

  // Freehand ink stroke commit: one transparent PNG picture element per stroke (cNvPr name has
  // the aislides-ink prefix, descr stores the vector points as JSON); undo/save/thumbnails all
  // go through the existing picture-element pipeline.
  ipcMain.handle('slides:add-ink', (e, op: AddInkOp) => ops.addInk(sessions.get(e.sender.id), op))

  // ── New insert capabilities: charts / SmartArt / icon bitmaps / audio-video / 3D / links / header-footer ──

  ipcMain.handle('slides:add-chart', (e, op: AddChartOp) =>
    ops.addChart(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:add-smartart', (e, op: AddSmartArtOp) =>
    ops.addSmartart(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:add-image-bytes', (e, op: AddImageBytesOp) =>
    ops.addImageBytes(sessions.get(e.sender.id), op),
  )

  // Show a dialog to pick video/audio and embed it. Video poster frame prefers the system thumbnail (QuickLook), falling back to a solid color on failure.
  ipcMain.handle(
    'slides:insert-media',
    async (e, slideIndex: number, kind: 'video' | 'audio', fitWidthPx: number) => {
      const session = sessions.get(e.sender.id)
      if (!session || !session.opened.deck.slides[slideIndex]) return null
      const parent = dialogParent()
      const filters =
        kind === 'video'
          ? [{ name: tm('filterVideo'), extensions: ['mp4', 'm4v', 'mov', 'webm', 'avi'] }]
          : [{ name: tm('filterAudio'), extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg'] }]
      const options = {
        title: kind === 'video' ? tm('dlgInsertVideo') : tm('dlgInsertAudio'),
        properties: ['openFile' as const],
        filters,
      }
      const r = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (r.canceled || !r.filePaths[0]) return null
      const filePath = r.filePaths[0]
      const bytes = await readFile(filePath)
      const ext = filePath.split('.').pop()!.toLowerCase()
      const fileName = filePath.split('/').pop()!

      // Warn up front when in-app playback will be broken — AVI has no
      // Chromium demuxer at all; mp4/m4v/mov with e.g. AC-3/DTS audio plays silent.
      if (kind === 'video') {
        let detail: string | null = null
        if (ext === 'avi') detail = tm('mediaAviBody')
        else if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
          const codec = unplayableAudioCodec(new Uint8Array(bytes))
          if (codec) detail = tm('mediaNoAudioBody', { codec })
        }
        if (detail) {
          const warn = {
            type: 'warning' as const,
            buttons: [tm('legacyPptOk')],
            message: tm('mediaUnsupportedTitle'),
            detail,
          }
          if (parent) await dialog.showMessageBox(parent, warn)
          else await dialog.showMessageBox(warn)
        }
      }

      let poster: { bytes: Uint8Array; ext: string } | undefined
      if (kind === 'video') {
        try {
          const thumb = await nativeImage.createThumbnailFromPath(filePath, {
            width: 960,
            height: 540,
          })
          if (!thumb.isEmpty()) poster = { bytes: new Uint8Array(thumb.toPNG()), ext: 'png' }
        } catch {
          /* Solid-color fallback */
        }
      }

      const deckSize = session.opened.deck.size
      const offset =
        kind === 'video'
          ? (() => {
              const cx = Math.round(deckSize.cx * 0.6)
              const cy = Math.round((cx * 9) / 16)
              return {
                x: Math.round((deckSize.cx - cx) / 2),
                y: Math.round((deckSize.cy - cy) / 2),
                cx,
                cy,
              }
            })()
          : (() => {
              const cx = Math.round(deckSize.cx * 0.24)
              const cy = Math.round(deckSize.cy * 0.09)
              return {
                x: Math.round((deckSize.cx - cx) / 2),
                y: Math.round((deckSize.cy - cy) / 2),
                cx,
                cy,
              }
            })()

      pushHistory(session)
      const added = addMedia(session.opened, slideIndex, {
        kind,
        bytes: new Uint8Array(bytes),
        ext,
        ...(poster ? { poster } : {}),
        offset,
        name: fileName,
      })
      if (!added) {
        session.undoStack.pop()
        return null
      }
      session.fitWidthPx = fitWidthPx
      const rebuilt = rebuildSlide(session, slideIndex)
      return rebuilt ? { slide: rebuilt, sourceId: added.elementId } : null
    },
  )

  ipcMain.handle('slides:media-data', (e, slideIndex: number, sourceId: string) =>
    ops.mediaData(sessions.get(e.sender.id), slideIndex, sourceId),
  )

  // Media recorded by the renderer (screen-recording webm): placed centered at 16:9
  ipcMain.handle('slides:add-media-bytes', (e, op: AddMediaBytesOp) =>
    ops.addMediaBytes(sessions.get(e.sender.id), op),
  )

  // 3D model (simplified): glb embed + poster placeholder image
  ipcMain.handle('slides:insert-model3d', async (e, slideIndex: number, fitWidthPx: number) => {
    const session = sessions.get(e.sender.id)
    if (!session || !session.opened.deck.slides[slideIndex]) return null
    const parent = dialogParent()
    const options = {
      title: tm('dlgInsert3d'),
      properties: ['openFile' as const],
      filters: [{ name: tm('filter3d'), extensions: ['glb', 'gltf'] }],
    }
    const r = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return null
    const filePath = r.filePaths[0]
    const bytes = await readFile(filePath)
    const ext = filePath.split('.').pop()!.toLowerCase()

    let poster: { bytes: Uint8Array; ext: string } | undefined
    try {
      const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: 640, height: 640 })
      if (!thumb.isEmpty()) poster = { bytes: new Uint8Array(thumb.toPNG()), ext: 'png' }
    } catch {
      /* Dark-gray fallback */
    }

    return ops.addModel3dBytes(session, {
      slideIndex,
      bytes: new Uint8Array(bytes),
      ext,
      ...(poster ? { poster } : {}),
      name: filePath.split('/').pop()!,
      fitWidthPx,
    })
  })

  ipcMain.handle('slides:set-link', (e, op: SetLinkOp) =>
    ops.setLink(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:get-link', (e, slideIndex: number, sourceId: string) =>
    ops.getLink(sessions.get(e.sender.id), slideIndex, sourceId),
  )

  ipcMain.handle('slides:get-slide-links', (e, slideIndex: number) =>
    ops.getSlideLinks(sessions.get(e.sender.id), slideIndex),
  )

  ipcMain.handle('slides:get-run-links', (e, slideIndex: number) =>
    ops.getRunLinks(sessions.get(e.sender.id), slideIndex),
  )

  ipcMain.handle('slides:apply-header-footer', (e, op: HeaderFooterOp) =>
    ops.applyHeaderFooter(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:get-header-footer', (e, slideIndex: number) =>
    ops.getHeaderFooter(sessions.get(e.sender.id), slideIndex),
  )

  // Apply a theme (Design tab theme gallery): rewrite theme*.xml colors/fonts (scheme-referenced
  // colors follow), and remap the deck's explicit srgbClr wholesale to the new theme palette
  // (real-world decks have almost entirely explicit colors, so swapping only the theme changes
  // nothing visually). Element resolved colors come from the parse-time inheritance chain, so
  // after the surgery the deck reparses in memory; undo snapshots roll back as usual.
  ipcMain.handle('slides:apply-theme', async (e, op: ApplyThemeOp) =>
    ops.applyTheme(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-transition', (e, op: SetTransitionOp) =>
    ops.setTransition(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:get-transition', (e, slideIndex: number) =>
    ops.getTransition(sessions.get(e.sender.id), slideIndex),
  )

  // Rehearsal timing save: batch-write each page's auto-advance time (<p:transition advTm>, ms)
  ipcMain.handle('slides:set-advance-times', (e, op: SetAdvanceTimesOp) =>
    ops.setAdvanceTimes(sessions.get(e.sender.id), op),
  )

  // ── Shape animations (<p:timing>; the spid <-> temporary element id mapping happens here) ──
  ipcMain.handle('slides:get-animations', (e, slideIndex: number): AnimationItem[] =>
    ops.getAnimations(sessions.get(e.sender.id), slideIndex, tm),
  )

  // Pairing keys for Morph transitions: sourceId changes on every reparse, so match across pages by cNvPr id/name
  ipcMain.handle('slides:get-shape-keys', (e, slideIndex: number): ShapeKey[] =>
    ops.getShapeKeys(sessions.get(e.sender.id), slideIndex),
  )

  ipcMain.handle('slides:set-animations', (e, op: SetAnimationsOp) =>
    ops.setAnimations(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:set-hidden', (e, op: SetSlideHiddenOp) =>
    ops.setHidden(sessions.get(e.sender.id), op),
  )

  // ── Section management: presentation.xml surgery, riding on snapshot undo and savePptx ──
  ipcMain.handle('slides:get-sections', (e) => ops.getSections(sessions.get(e.sender.id)))

  ipcMain.handle('slides:set-sections', (e, sections: SectionInfo[]) =>
    ops.setSections(sessions.get(e.sender.id), sections),
  )

  ipcMain.handle('slides:add-section', (e, op: AddSectionOp) =>
    ops.addSection(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:rename-section', (e, op: RenameSectionOp) =>
    ops.renameSection(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:remove-section', (e, op: RemoveSectionOp) =>
    ops.removeSection(sessions.get(e.sender.id), op),
  )

  // Drag to reorder slides (sldIdLst + deck.slides + section membership); must send back the full RenderSlide set
  ipcMain.handle('slides:move-slide', (e, op: MoveSlideOp) =>
    ops.moveSlide(sessions.get(e.sender.id), op),
  )

  // Moving a whole section changes slide order (sldIdLst + deck.slides); must send back the full RenderSlide set
  ipcMain.handle('slides:move-section', (e, op: MoveSectionOp) =>
    ops.moveSection(sessions.get(e.sender.id), op),
  )

  // ── Speaker notes / comments (archive surgery, riding on snapshot undo and savePptx) ────
  ipcMain.handle('slides:get-notes', (e, slideIndex: number) =>
    ops.getNotes(sessions.get(e.sender.id), slideIndex),
  )

  ipcMain.handle('slides:set-notes', (e, op: SetNotesOp) =>
    ops.setNotes(sessions.get(e.sender.id), op),
  )

  ipcMain.handle('slides:get-comments', (e, slideIndex: number) =>
    ops.getComments(sessions.get(e.sender.id), slideIndex),
  )

  ipcMain.handle('slides:add-comment', (e, op: AddCommentOp) =>
    ops.addComment(sessions.get(e.sender.id), op, commentAuthorName),
  )

  ipcMain.handle('slides:delete-comment', (e, op: DeleteCommentOp) =>
    ops.deleteComment(sessions.get(e.sender.id), op),
  )

  // System clipboard while text-editing (menu commands are echoed back by the renderer per context)
  ipcMain.handle('slides:native-clipboard', (e, op: 'cut' | 'copy' | 'paste') => {
    if (op === 'cut') e.sender.cut()
    else if (op === 'copy') e.sender.copy()
    else e.sender.paste()
  })

  ipcMain.handle('slides:history-batch-begin', (e) =>
    ops.historyBatchBegin(sessions.get(e.sender.id)),
  )

  ipcMain.handle('slides:history-batch-end', (e) => ops.historyBatchEnd(sessions.get(e.sender.id)))

  ipcMain.handle('slides:ai-snapshot-restore', (e, id: number) =>
    ops.aiSnapshotRestore(sessions.get(e.sender.id), id),
  )

  ipcMain.handle('slides:undo', (e) => ops.undo(sessions.get(e.sender.id)))

  ipcMain.handle('slides:redo', (e) => ops.redo(sessions.get(e.sender.id)))

  ipcMain.handle('slides:is-dirty', (e) => ops.isDirty(sessions.get(e.sender.id)))

  // `_auto` is not read, and that is this host's whole story: it writes into its own drafts
  // folder or over the open file with no permission to ask for, so an unattended save and a
  // deliberate one are the same silent write. The flag exists for hosts that must ask.
  ipcMain.handle('slides:save', async (e, _auto: boolean) => {
    const session = sessions.get(e.sender.id)
    if (!session) return { ok: false, error: 'no file open' }
    // Untitled (new blank file): the first save lands silently in the drafts folder (Save As keeps its dialog)
    if (!session.path) {
      const draftsDir = getDraftsDir()
      if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true })
      session.path = pickDraftPath(draftsDir, tm('untitledDeck'))
      await pushRecent(session.path)
      slidesOpenedHook?.(e.sender, session.path)
    }
    try {
      await savePptxToFile(session.opened, session.path)
      autosaveBackoff.delete(session.path)
      void rm(autosavePathFor(session.path), { force: true }).catch(() => {})
      dropUntitledRecovery(e.sender.id)
      // Bake the saved patches back into the in-memory model (clears dirty, syncs
      // anchor.originalXml with disk) — a full reopen would re-read and unzip the
      // whole package, doubling save latency on large decks. Element ids survive,
      // but the renderer still expects the render tree in the response.
      commitSaved(session.opened)
      session.metaDirty = false
      return {
        ok: true,
        path: session.path,
        name: baseName(session.path),
        slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('slides:save-as', async (e, defaultName: string) => {
    const session = sessions.get(e.sender.id)
    if (!session) return { ok: false, error: 'no file open' }
    const parent = dialogParent()
    const options = {
      defaultPath: defaultName,
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    }
    const r = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return { ok: false }
    try {
      await savePptxToFile(session.opened, r.filePath)
      session.path = r.filePath
      autosaveBackoff.delete(r.filePath)
      dropUntitledRecovery(e.sender.id)
      await pushRecent(r.filePath)
      slidesOpenedHook?.(e.sender, r.filePath)
      commitSaved(session.opened)
      session.metaDirty = false
      return {
        ok: true,
        path: r.filePath,
        name: baseName(r.filePath),
        slides: buildAllRenderSlides(session.opened, session.fitWidthPx),
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ── Export (PDF / images): the renderer renders hi-res PNGs with offscreen Konva; the main process handles dialogs/writing ──

  ipcMain.handle('slides:pick-export-dir', async () => {
    const parent = dialogParent()
    const options = {
      title: tm('dlgPickExportDir'),
      buttonLabel: tm('btnExport'),
      properties: ['openDirectory' as const, 'createDirectory' as const],
    }
    const r = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle(
    'slides:export-images',
    async (_e, op: ExportImagesOp): Promise<ExportImagesResult> => {
      try {
        // Zero-padding width follows the total page count (3 digits for ≥100 pages)
        const pad = op.pngsBase64.length >= 100 ? 3 : 2
        const paths: string[] = []
        for (let i = 0; i < op.pngsBase64.length; i++) {
          const p = join(op.dir, `${op.baseName}-${String(i + 1).padStart(pad, '0')}.png`)
          await writeFile(p, Buffer.from(op.pngsBase64[i], 'base64'))
          paths.push(p)
        }
        return { ok: true, paths }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )

  ipcMain.handle('slides:pick-export-pdf-path', async (_e, defaultName: string) => {
    const parent = dialogParent()
    const options = {
      title: tm('dlgExportPdf'),
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }
    const r = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    return r.canceled || !r.filePath ? null : r.filePath
  })

  ipcMain.handle('slides:export-pdf', async (_e, op: ExportPdfOp): Promise<ExportPdfResult> => {
    // PDF page size: fixed 7.5in height, width by slide ratio (16:9 -> 13.333in, 4:3 -> 10in)
    const heightIn = 7.5
    const widthIn = Math.round((op.widthPx / op.heightPx) * heightIn * 1000) / 1000
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${widthIn}in ${heightIn}in; margin: 0; }
html, body { margin: 0; padding: 0; }
.page { width: ${widthIn}in; height: ${heightIn}in; overflow: hidden; page-break-after: always; }
.page:last-child { page-break-after: auto; }
.page img { display: block; width: 100%; height: 100%; }
</style></head><body>${op.pngsBase64
      .map((b64) => `<div class="page"><img src="data:image/png;base64,${b64}"></div>`)
      .join('')}</body></html>`
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await win.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))
      // Wait for fonts and all images to decode before printing, avoiding blank pages
      await win.webContents.executeJavaScript(
        'Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode().catch(() => {}))])',
        true,
      )
      const pdf = await win.webContents.printToPDF({
        landscape: false, // The page size is already landscape (width > height); passing landscape would rotate a second time
        printBackground: true,
        pageSize: { width: widthIn, height: heightIn },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: false,
      })
      await writeFile(op.filePath, pdf)
      return { ok: true, path: op.filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    } finally {
      win.destroy()
    }
  })

  ipcMain.handle(
    'slides:print',
    async (e, op: PrintSlidesOp): Promise<{ ok: boolean; error?: string }> => {
      const layout = op.layout ?? 'full'
      const ratio = op.widthPx / op.heightPx
      // Full page: page size matches the slide ratio; handouts/notes: A4 portrait holding multiple thumbnails
      const slideH = 7.5
      const slideW = Math.round(ratio * slideH * 1000) / 1000
      const isFull = layout === 'full'
      const pageW = isFull ? slideW : 8.27
      const pageH = isFull ? slideH : 11.69
      const perPage =
        layout === 'handout2' ? 2 : layout === 'handout3' ? 3 : layout === 'handout6' ? 6 : 1
      const esc = (x: string) =>
        x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

      let body: string
      if (isFull) {
        body = op.pngsBase64
          .map((b64) => `<div class="page"><img src="data:image/png;base64,${b64}"></div>`)
          .join('')
      } else if (layout === 'notes') {
        // Notes page: slide on top + notes text below
        body = op.pngsBase64
          .map(
            (b64, i) =>
              `<div class="page notes"><img src="data:image/png;base64,${b64}">` +
              `<div class="note">${esc(op.notes?.[i] ?? '').replace(/\n/g, '<br>')}</div></div>`,
          )
          .join('')
      } else {
        // Handouts: perPage thumbnails per page (with 3, ruled lines on the right for handwriting)
        const pages: string[] = []
        for (let i = 0; i < op.pngsBase64.length; i += perPage) {
          const cells = op.pngsBase64
            .slice(i, i + perPage)
            .map(
              (b64) =>
                `<div class="cell"><img src="data:image/png;base64,${b64}">` +
                (perPage === 3 ? '<div class="rules"></div>' : '') +
                '</div>',
            )
            .join('')
          pages.push(`<div class="page handout h${perPage}">${cells}</div>`)
        }
        body = pages.join('')
      }

      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${pageW}in ${pageH}in; margin: 0; }
html, body { margin: 0; padding: 0; font-family: -apple-system, 'Segoe UI', sans-serif; }
.page { width: ${pageW}in; height: ${pageH}in; overflow: hidden; page-break-after: always; box-sizing: border-box; }
.page:last-child { page-break-after: auto; }
.page > img { display: block; width: 100%; height: 100%; }
.page.handout { padding: 0.4in; display: flex; flex-direction: column; gap: 0.24in; }
.page.handout .cell { display: flex; gap: 0.2in; align-items: center; flex: 1; min-height: 0; }
.page.handout .cell img { border: 1px solid #bbb; object-fit: contain; max-height: 100%; }
.page.handout.h2 .cell img, .page.handout.h6 .cell img { width: 100%; height: auto; max-height: 100%; }
.page.handout.h3 .cell img { width: 55%; height: auto; }
.page.handout.h3 .rules {
  flex: 1; align-self: stretch;
  background: repeating-linear-gradient(#fff 0 0.28in, #ccc 0.28in calc(0.28in + 1px));
}
.page.handout.h6 { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 1fr; }
.page.notes { padding: 0.5in; display: flex; flex-direction: column; }
.page.notes img { width: 100%; height: auto; border: 1px solid #bbb; }
.page.notes .note { margin-top: 0.3in; font-size: 11pt; line-height: 1.5; white-space: pre-wrap; }
</style></head><body>${body}</body></html>`
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await win.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))
        await win.webContents.executeJavaScript(
          'Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode().catch(() => {}))])',
          true,
        )
        const ok = await new Promise<boolean>((resolve) => {
          win.webContents.print({ silent: false, printBackground: true }, (success) =>
            resolve(success),
          )
        })
        return { ok }
      } catch (err) {
        return { ok: false, error: String(err) }
      } finally {
        win.destroy()
      }
    },
  )

  ipcMain.handle('slides:recent', () => readRecent())

  // ── Chat attachments (slides:files-*) ──
  registerAttachmentIpc()

  // ── Presenter-view multi-screen show (registered inside registerSlidesIpc: shell
  // aggregate mode only calls this function) ──
  registerPresenterIpc()

  registerSlidesOnlyAiIpc()
}

// ── project-store IPC (standalone mode) ───────────────────────────────────
// In shell mode docs-main.registerProjectIpc registers these centrally (idempotent guard,
// registers once). Slides standalone calls this function.

let slidesProjectStore: ProjectStore | null = null
let slidesProjectIpcRegistered = false

function getSlidesProjectStore(): ProjectStore {
  if (!slidesProjectStore) slidesProjectStore = new ProjectStore(app.getPath('userData'))
  return slidesProjectStore
}

export function registerProjectIpc(): void {
  if (slidesProjectIpcRegistered) return
  slidesProjectIpcRegistered = true

  ipcMain.handle(
    'project:resolveChat',
    (_event, args: { filePath: string | null; tempChatId?: string }) => {
      const store = getSlidesProjectStore()
      store.ensureDefaultProject()
      if (!args.filePath) {
        return { projectId: 'default', chatId: args.tempChatId ?? `unsaved-${Date.now()}` }
      }
      return store.resolveChatForFile(args.filePath)
    },
  )

  ipcMain.handle(
    'project:appendChat',
    (
      _event,
      args: {
        projectId: string
        chatId: string
        role: 'user' | 'assistant'
        text: string
        tools?: Array<{
          name: string
          summary: string
          isError?: boolean
          input?: string
          output?: string
        }>
        attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>
      },
    ) => {
      const msg: Parameters<ProjectStore['appendChatMessage']>[2] = {
        role: args.role,
        text: args.text,
      }
      if (args.tools) msg.tools = args.tools
      if (args.attachments) msg.attachments = args.attachments
      getSlidesProjectStore().appendChatMessage(args.projectId, args.chatId, msg)
    },
  )

  ipcMain.handle(
    'project:loadChat',
    (_event, args: { projectId: string; chatId: string; limit?: number }) => {
      return getSlidesProjectStore().loadChat(args.projectId, args.chatId, args.limit ?? 200)
    },
  )

  ipcMain.handle(
    'project:rebindChat',
    (
      _event,
      args: { projectId: string; tempChatId: string; newChatId?: string; newFilePath?: string },
    ) => {
      const store = getSlidesProjectStore()
      if (args.newFilePath) {
        return store.rebindChatToFile(args.projectId, args.tempChatId, args.newFilePath)
      }
      if (args.newChatId) store.rebindChat(args.projectId, args.tempChatId, args.newChatId)
      return { projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId }
    },
  )
}

export function createSlidesWindow(openPath?: string | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'GenOffice Slides',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#ffffff', symbolColor: '#444444', height: 40 },
        }),
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  trackSlidesWebContents(win.webContents)
  // Close guard for standalone-window mode (tab mode runs the same flow via the shell's tab-manager/window-close path)
  win.on('close', (event) => {
    if (!slidesIsDirty(win.webContents.id)) return
    event.preventDefault()
    void requestSlidesClose(win.webContents, win).then((proceed) => {
      // destroy() exits bypassing this handler (close() would re-enter the guard)
      if (proceed && !win.isDestroyed()) win.destroy()
    })
  })

  if (runtime.rendererDevUrl) win.loadURL(runtime.rendererDevUrl)
  else if (runtime.rendererFilePath) win.loadFile(runtime.rendererFilePath)

  if (openPath) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await openAndBuild(win.webContents, openPath, 1280)
        win.webContents.send('slides:opened', result)
      } catch {
        /* ignore */
      }
    })
  }
  return win
}

/** per-webContents background setter: opaque white while (re)loading, flipped
 * to transparent by consume-pending-open once the renderer has mounted, so the
 * vibrancy hole never shows the raw desktop behind an unpainted page */
const vibFlip = new Map<number, (color: string) => void>()

function armVibrancy(view: WebContentsView): void {
  if (process.platform !== 'darwin') return
  const setColor = (c: string) => view.setBackgroundColor(c)
  setColor('#ffffff')
  // view.webContents becomes undefined after destroy, so grab the id beforehand
  const wcId = view.webContents.id
  vibFlip.set(wcId, setColor)
  view.webContents.on('did-start-loading', () => setColor('#ffffff'))
  view.webContents.once('destroyed', () => vibFlip.delete(wcId))
}

/** Tab version of createSlidesWindow: same runtime/IPC, hosted in the shell's WebContentsView */
export function createSlidesView(openPath?: string | null): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  registerSlidesIpc()
  trackSlidesWebContents(view.webContents)
  armVibrancy(view)
  // The renderer calls consumePendingOpen on mount; use that to avoid a did-finish-load timing race
  if (openPath && existsSync(openPath)) pendingByWc.set(view.webContents.id, openPath)
  // mode=tab: the shell's tab strip owns the traffic lights / caption buttons,
  // so the ribbon must not reserve space for them
  if (runtime.rendererDevUrl) {
    // append via URL so a dev URL that already carries query params stays valid
    const devUrl = new URL(runtime.rendererDevUrl)
    devUrl.searchParams.set('mode', 'tab')
    void view.webContents.loadURL(devUrl.toString())
  } else if (runtime.rendererFilePath)
    void view.webContents.loadFile(runtime.rendererFilePath, { query: { mode: 'tab' } })
  return view
}

/** Items the shell injects into the File menu (e.g. Back to Home) */
let extraFileMenuItems: Electron.MenuItemConstructorOptions[] = []
export function setSlidesExtraFileMenuItems(items: Electron.MenuItemConstructorOptions[]): void {
  extraFileMenuItems = items
}

/** Tab mode: Cmd+W closes the current tab rather than the whole shell window */
let closeActiveTabHook: (() => void) | null = null
export function setSlidesCloseTabHook(fn: (() => void) | null): void {
  closeActiveTabHook = fn
}

export function buildSlidesMenu(): Menu {
  const send = (cmd: string) =>
    (windowRefs.activeWebContents ?? BrowserWindow.getFocusedWindow()?.webContents)?.send(
      'slides:menu',
      cmd,
    )
  const isMac = process.platform === 'darwin'
  const labels = appMenuLabels(getUiLang())
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: tm('menuFile'),
      submenu: [
        { label: tm('menuOpen'), accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        ...(extraFileMenuItems.length > 0
          ? [{ type: 'separator' as const }, ...extraFileMenuItems]
          : []),
        { type: 'separator' },
        { label: tm('menuSave'), accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: tm('menuSaveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        // The ribbon's File tab is Windows-only, so without these macOS had no way
        // to export or print at all
        { label: tm('menuExportPdf'), click: () => send('export-pdf') },
        { label: tm('menuExportImages'), click: () => send('export-images') },
        { label: tm('menuPrint'), accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        closeActiveTabHook
          ? {
              label: isMac ? tm('menuClose') : tm('menuQuit'),
              accelerator: isMac ? 'CmdOrCtrl+W' : 'CmdOrCtrl+Q',
              click: () => closeActiveTabHook?.(),
            }
          : isMac
            ? { role: 'close' as const, label: tm('menuClose') }
            : { role: 'quit' as const, label: tm('menuQuit') },
      ],
    },
    {
      label: tm('menuEdit'),
      submenu: [
        // Undo/redo are sent to the renderer: text-editing state uses native execCommand, otherwise document history
        { label: tm('menuUndo'), accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: tm('menuRedo'), accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        // Cut/copy/paste forward the same way: in text state the renderer calls back to the native clipboard; in canvas state the element clipboard is used
        { label: tm('menuCut'), accelerator: 'CmdOrCtrl+X', click: () => send('cut') },
        { label: tm('menuCopy'), accelerator: 'CmdOrCtrl+C', click: () => send('copy') },
        { label: tm('menuPaste'), accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
        { role: 'selectAll', label: labels.selectAll },
      ],
    },
    {
      label: tm('menuView'),
      submenu: [
        { label: tm('menuZoomIn'), accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        { label: tm('menuZoomOut'), accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        {
          label: tm('menuActualSize'),
          accelerator: 'CmdOrCtrl+0',
          click: () => send('zoom-reset'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: labels.toggleDevTools },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

export function installSlidesMenu(): void {
  Menu.setApplicationMenu(buildSlidesMenu())
}

/**
 * Attach a proxy to the main process's global fetch. Environment variables take priority;
 * otherwise, after app ready, read the system proxy via session.resolveProxy() (the critical
 * path for packaged builds launched by double-click).
 */
async function applyMainProcessProxy(): Promise<void> {
  const setDispatcher = async (proxyUrl: string) => {
    try {
      const { ProxyAgent, setGlobalDispatcher } = await import('undici')
      setGlobalDispatcher(new ProxyAgent(proxyUrl))
      // strip user:pass credentials before logging
      console.log('[proxy] main-process fetch via', proxyUrl.replace(/\/\/[^@/]*@/, '//***@'))
    } catch (e) {
      console.warn('[proxy] failed to set ProxyAgent:', e)
    }
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (envProxy) {
    await setDispatcher(envProxy)
    return
  }
  // No environment variables: read the system proxy (requires app ready)
  try {
    await app.whenReady()
    const resolved = await electronSession.defaultSession.resolveProxy('https://api.anthropic.com')
    // resolveProxy returns strings like "PROXY 127.0.0.1:1087" or "DIRECT"
    const m = /PROXY\s+([^;]+)/i.exec(resolved || '')
    if (m) {
      await setDispatcher(`http://${m[1].trim()}`)
    } else {
      console.log('[proxy] system proxy = DIRECT, no dispatcher set')
    }
  } catch (e) {
    console.warn('[proxy] resolveProxy failed:', e)
  }
}

export function startSlidesStandalone(): void {
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  // Optional debug switch: enable CDP only in dev with SLIDES_CDP_PORT explicitly set (for
  // automated testing/troubleshooting); packaged builds (isPackaged) are unaffected.
  if (!app.isPackaged && process.env.SLIDES_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.SLIDES_CDP_PORT)
    app.commandLine.appendSwitch('remote-allow-origins', '*')
  }
  // GENOFFICE_USER_DATA: test drivers point this at a scratch dir so automated
  // instances get their own userData AND single-instance lock (the lock is scoped
  // to userData), allowing parallel instances alongside a normal dev run.
  if (!app.isPackaged && process.env.GENOFFICE_USER_DATA) {
    app.setPath('userData', process.env.GENOFFICE_USER_DATA)
  }
  // The main process's Node fetch (undici) does not use the system proxy by default, so access
  // from mainland China to overseas LLM APIs like api.anthropic.com hits ETIMEDOUT on direct
  // connections. Route the global dispatcher through the proxy; the renderer (Chromium) uses
  // the system proxy on its own and is unaffected. Prefer environment variables (terminal
  // launches); packaged builds launched by double-click don't inherit terminal environment
  // variables, so fall back to Electron session.resolveProxy() reading the system proxy
  // settings.
  void applyMainProcessProxy()
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady()) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        openAndBuild(win.webContents, path, 1280).then((r) =>
          win.webContents.send('slides:opened', r),
        )
        win.focus()
      } else createSlidesWindow(path)
    } else pendingOpenPath = path
  })

  const argPath = process.argv.find((a) => a.toLowerCase().endsWith('.pptx'))
  if (argPath && existsSync(argPath)) pendingOpenPath = argPath

  app.whenReady().then(async () => {
    setUiLang(normalizeLang(process.env.GENOFFICE_LANG ?? app.getLocale()))
    registerSlidesIpc()
    registerAiIpc()
    registerProjectIpc()
    Menu.setApplicationMenu(buildSlidesMenu())
    const win = createSlidesWindow(pendingOpenPath)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createSlidesWindow()
    })

    // Test-only: with SLIDES_SMOKE_SHOT=/path, take a screenshot after loading and quit
    if (!app.isPackaged && process.env.SLIDES_SMOKE_SHOT) {
      win.webContents.once('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, 1800))
        try {
          const info = await win.webContents.executeJavaScript(
            `({ thumbs: document.querySelectorAll('.thumb').length,` +
              ` canvases: document.querySelectorAll('canvas').length,` +
              ` empty: !!document.querySelector('.empty') })`,
          )

          console.log('SMOKE_INFO=' + JSON.stringify(info))
          const png = await win.webContents.capturePage()
          const { writeFileSync } = await import('node:fs')
          writeFileSync(process.env.SLIDES_SMOKE_SHOT!, png.toPNG())

          console.log('SMOKE_SHOT_OK')
        } catch (e) {
          console.error('SMOKE_ERR', e)
        }
        app.quit()
      })
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
