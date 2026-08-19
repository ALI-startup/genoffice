/**
 * Builds docs' platform for a browser, from a `WebDocumentStore` and a few
 * injected browser surfaces.
 *
 * The mirror of platform-electron.ts, and it follows the same division: the
 * shared ports come from @samugen/platform-web, and docs' own surfaces — the
 * docx document operations and the window/close-guard channels — are adapted
 * here, next to the port declarations they satisfy. Nothing in this file touches
 * a browser global: the store, the pickers, the AI port and the activation probe
 * are all passed in, so this module is exercisable without a real `window`, and
 * host-web.ts is the only file that reads globals.
 *
 * Where Electron's file port is mostly a rename (its `DocumentRef` *is* a path,
 * so it forwards to IPC), this one does the work in the renderer. That costs
 * nothing to arrange, because @samugen/docx-engine already runs in the docs
 * renderer: the parsing and the docx serialization were always renderer-side, and
 * the Electron main process only ever received finished bytes and wrote them to
 * disk. So the browser needs exactly one thing the desktop had — somewhere to put
 * the bytes — and `WebDocumentStore` is that.
 *
 * Three members of `DocsFilePort` cannot be honoured on the web and say so by
 * their result rather than by pretending:
 *
 *   - `writeRecoveryCopy` always returns `{ ok: false }`. Electron writes a
 *     crash-recovery copy under `userData`, out of band from the document, and
 *     reads it back at startup. A browser has no out-of-band location the *host*
 *     controls, and — decisively — nothing on the web would ever read such a copy
 *     back, because the recovery-scan lives in the main process. Writing bytes
 *     into the origin-private file system that no code path reads would be
 *     ceremony, not recovery, so this reports honestly that no copy was made.
 *     (The caller treats the copy as best-effort and ignores the result.)
 *   - `onOpenDocument` / `onDocumentRenamed` are real subscriptions with no
 *     emissions; see `createWebDocsFilePort`.
 *
 * And `saveNew` refuses an *automatic* save outright, which is a browser rule
 * rather than a gap — see the comment on it, and `download` for where the bytes of
 * a never-saved document go instead.
 *
 * One member does reach for `window` directly: `createWebDocsPrintPort` listens
 * for `afterprint`, an event with no injectable source (the dialog it reports on
 * is the browser's). The call that *opens* the dialog is still injected, so a test
 * drives the whole port without a real print, and jsdom supplies the event target.
 */
import type { AiPort, AttachmentsPort, DiskFileState, LanguagePort } from '@samugen/platform'
import { isExternallyModified } from '@samugen/platform'
import type { FilePickers, FrameChildLink, WebDocumentStore } from '@samugen/platform-web'
import {
  HWPX_FILE_TYPES,
  IMAGE_FILE_TYPES,
  createWebUnloadPrompt,
  ensurePermission,
  isPickerCancel,
} from '@samugen/platform-web'
import type { PickImageResult } from '../shared/ipc'
import type {
  CloseCheckState,
  DocsDownloadPort,
  DocsFilePort,
  DocsHwpxPort,
  DocsPlatform,
  DocsPrintPort,
  DocsWindowPort,
  DocumentRef,
  DownloadResult,
  HwpxExportResult,
  OpenOutcome,
  RecentDocument,
  SaveDocumentResult,
  SaveNamedDocumentResult,
} from './platform'

/**
 * Recognises a `.hwpx` by its display name.
 *
 * The name is all there is to go on: a `DocumentRef` is opaque and the picker
 * hands back a handle, not a type. That is enough — the name is what the user
 * picked, from a dialog filtered to these extensions.
 */
const HWPX_NAME = /\.hwpx$/i

/**
 * The one browser rule that shapes this host: `showSaveFilePicker` may only be
 * called while the page holds transient user activation. A browser has no
 * "default folder" to save into silently, so naming a document *requires* a
 * dialog, and a dialog requires a gesture.
 *
 * `navigator.userActivation.isActive` is how that is asked. Injected rather than
 * read directly so this module stays testable, and so the fallback for a browser
 * without the API is a single, visible decision (assume activation and let the
 * picker itself reject) instead of scattered guards.
 *
 * What it must not be used for is deciding whether a save *should* open a dialog.
 * Activation is renewed by every keystroke and outlives it by seconds, so a
 * document being edited holds it continuously — an automatic save would pass this
 * probe every time. Intent comes from the caller (`saveNew`'s `auto`); this only
 * answers whether the browser would permit the dialog at all.
 */
export interface UserActivationProbe {
  (): boolean
}

/**
 * Ask the user whether to overwrite a document another program has changed since
 * it was opened. `true` overwrites.
 *
 * The browser counterpart of the native warning box the Electron main process
 * shows on the same condition, and injected for the same reason as everything
 * else here: this module reaches no globals, and a test can answer the question
 * both ways. The host supplies the wording, so it stays localised through the
 * renderer's own i18n rather than duplicating the main process's dictionary.
 */
export interface ConfirmOverwrite {
  (): boolean
}

export interface WebDocsPlatformDeps {
  store: WebDocumentStore
  /** Used only for the image picker; the document dialogs go through the store. */
  pickers: FilePickers
  language: LanguagePort
  ai: AiPort
  attachments: AttachmentsPort
  hasUserActivation: UserActivationProbe
  confirmOverwrite: ConfirmOverwrite
  /** Install a `beforeunload` guard; injected so tests can drive it. Defaults to the real one. */
  unloadPrompt?: typeof createWebUnloadPrompt
  /**
   * The web shell's frame link when this page is hosted in its tab strip, `null`
   * when it is a standalone browser tab. It is what makes the close guard real
   * for a tab close, which `beforeunload` cannot see; see
   * `createWebDocsWindowPort`.
   */
  frame?: FrameChildLink | null
  /** Opens the browser's print dialog; injected so tests can drive it. Defaults to `window.print`. */
  printPage?: () => void
  /**
   * Hands a file to the user's downloads. Injected like every other browser
   * surface here, so `download` is exercisable without a DOM; host-web.ts supplies
   * @samugen/platform-web's `downloadBytes`.
   */
  deliverDownload: DownloadDelivery
}

/**
 * Start a download of `data` under `fileName`.
 *
 * Synchronous and returning nothing, because that is the truth of the operation:
 * a page can only hand the bytes to the browser. It throws only if the handover
 * itself fails.
 */
export interface DownloadDelivery {
  (fileName: string, data: ArrayBuffer, mimeType: string): void
}

/**
 * docs' docx document surface over the File System Access API.
 *
 * The Electron adapter's `DocumentRef` is an absolute path; here it is a key the
 * store resolves to a `FileSystemFileHandle`, and this file never inspects one.
 */
export function createWebDocsFilePort(
  store: WebDocumentStore,
  pickers: FilePickers,
  hasUserActivation: UserActivationProbe,
  confirmOverwrite: ConfirmOverwrite,
): DocsFilePort {
  /**
   * What the file looked like the last time this host read or wrote it, per ref.
   *
   * The browser half of the same bookkeeping `docDiskStates` performs in the
   * Electron main process, and the reason a web save can refuse to clobber
   * another program's edits. Kept per page rather than persisted: a reload has to
   * reopen the document anyway, and the reopen records a fresh snapshot.
   */
  const disk = new Map<DocumentRef, DiskFileState>()

  /** Record the post-read/post-write state. Best-effort: an unstatable ref simply is not tracked. */
  const remember = async (ref: DocumentRef, hash: string): Promise<void> => {
    try {
      const { lastModified, size } = await store.stat(ref)
      disk.set(ref, { mtimeMs: lastModified, size, hash })
    } catch {
      /* not tracked; the next save then cannot flag a conflict, exactly as in main */
    }
  }

  /**
   * Read a document the store has already granted us, as the renderer wants it.
   *
   * The `hash` is the real sha256 of the bytes as opened, computed here rather
   * than left empty: it is what Electron's main process keys its original-file
   * archive by, and although this host keeps no archive, a wrong or blank value
   * would be a lie sitting in `DocState` waiting for the first consumer. It is
   * also the baseline for conflict detection, which is the second reason it must
   * be a real hash.
   */
  const load = async (ref: DocumentRef, name: string): Promise<OpenOutcome> => {
    const bytes = await store.read(ref)
    if (HWPX_NAME.test(name)) return importHwpx(ref, name, bytes)
    const data = toArrayBuffer(bytes)
    const hash = await sha256Hex(data)
    await remember(ref, hash)
    return { kind: 'document', document: { ref, name, data, hash } }
  }

  /**
   * Convert a picked `.hwpx` and hand it over as an import.
   *
   * The handle is released rather than kept. Everything the store remembers a
   * handle *for* — saving in place, conflict detection, the recent list — is
   * about a file this app can write back to, and this one it cannot: the import
   * becomes an unsaved `.docx`. Leaving the handle behind would put a document
   * in the recent list that reopening would silently re-import.
   */
  const importHwpx = async (
    ref: DocumentRef,
    name: string,
    bytes: Uint8Array,
  ): Promise<OpenOutcome> => {
    // Loaded on demand: the converter is the heaviest thing in this bundle and a
    // session that never opens a .hwpx should not download it.
    const { hwpxToHtml } = await import('@samugen/hwpx-convert')
    try {
      const imported = await hwpxToHtml(bytes)
      return {
        kind: 'import',
        imported: {
          ...imported,
          sourceName: name,
          name: `${name.replace(HWPX_NAME, '')}.docx`,
        },
      }
    } finally {
      // Released whether or not the conversion worked: a file that failed to
      // convert is not a document either.
      await store.forget(ref).catch(() => {})
    }
  }

  /**
   * Has another program written this document since we last read or wrote it?
   *
   * `isExternallyModified` is @samugen/platform's shared predicate — the very
   * function the Electron main process calls — so the two hosts cannot disagree
   * about what a conflict is. Its performance property is preserved here: the
   * `readHash` callback is what rereads the file, and it only runs when
   * last-modified + size already disagree, so an ordinary save stats the document
   * once and reads nothing.
   */
  const changedExternally = async (ref: DocumentRef): Promise<boolean> => {
    let current: { mtimeMs: number; size: number } | null
    try {
      const { lastModified, size } = await store.stat(ref)
      current = { mtimeMs: lastModified, size }
    } catch {
      // Unreadable now (deleted, or the grant lapsed): not a conflict, and the
      // write below reports its own failure if it cannot proceed.
      current = null
    }
    return isExternallyModified(disk.get(ref), current, async () => {
      try {
        return await sha256Hex(toArrayBuffer(await store.read(ref)))
      } catch {
        return null
      }
    })
  }

  return {
    /**
     * Always null, and honestly so: "pending" means a host queued a document into
     * this view when it created it. A browser tab is opened by the user, not by a
     * host with a document in hand, so there is never anything queued — which is
     * what makes the renderer fall through to a blank document on first load.
     */
    consumePending: async () => null,

    /**
     * True, because that is what actually happened: a fresh browser tab of the
     * app *is* a new blank document. The flag is a one-shot in Electron because
     * the shell sets it when it creates a blank tab; here the condition it
     * describes is simply always the case on the load that asks.
     */
    consumeNewBlank: async () => true,

    /**
     * A real subscription this host never emits for. Electron's source is the OS:
     * double-clicking a .docx in Finder/Explorer routes through the file
     * association into the running app. A browser has no file association and no
     * channel by which anything outside the page can hand it a document, so there
     * is no event to deliver. Subscribing still works and every subscriber keeps
     * running unchanged; `openDocument` is how a document gets in here.
     */
    onOpenDocument: () => () => {},

    /**
     * A real subscription this host never emits for. Electron's source is the
     * shell's Home list, where renaming a file re-points the open editor at it.
     * There is no shell in a browser, and a File System Access handle follows its
     * file across a rename anyway, so nothing needs re-pointing.
     */
    onDocumentRenamed: () => () => {},

    openDocument: async () => {
      const picked = await store.open()
      return picked ? load(picked.ref, picked.name) : null
    },

    openDocumentByRef: async (ref) => {
      // `reopen` is what makes the recent list work across reloads: the handle
      // comes back from IndexedDB with no permission, and it re-prompts. It
      // throws when the ref is unknown or the user declines, which is a real
      // failure the caller shows — not a silent empty document.
      const reopened = await store.reopen(ref)
      return load(reopened.ref, reopened.name)
    },

    /**
     * Save in place, through a writable stream — the same file the user opened,
     * not a download into ~/Downloads. That is the whole point of building on the
     * File System Access API: a "save" that produced a second copy next to the
     * original would not be a save.
     *
     * Guarded against clobbering another program's edits, with the same two-branch
     * behaviour as the Electron host and for the same reason — a document open here
     * and edited in Word must not lose Word's changes:
     *
     *   - an **autosave** never prompts. It reports `external-modified`, the
     *     renderer stays dirty and shows nothing (it knows the host has handled
     *     the notification), and the next manual save raises the question.
     *   - a **manual save** asks, and overwrites only on an explicit yes. Declining
     *     reports `external-modified` too, so nothing is written and the document
     *     stays dirty.
     *
     * "An autosave never prompts" covers the *permission* grant as well, and that
     * is the second dialog this host could otherwise raise on a timer. A document
     * opened through the open dialog is granted read; writing it is a second grant
     * the browser asks for separately, and a handle restored after a reload starts
     * with neither. Requesting either from an autosave would either put a
     * permission dialog on screen unbidden or — with no user activation behind the
     * request — be rejected outright and read as a failed save. So an autosave
     * writes through `prompt: false`, which proceeds on a standing grant and
     * declines with `needs-permission` when there is none.
     *
     * The one divergence from Electron is the dialog itself: the main process shows
     * a native message box with Overwrite / Cancel buttons, and this host shows the
     * browser's own confirm dialog, which is the closest a page can get. Same
     * question, same two outcomes, unstyled wording chosen by the browser.
     */
    save: async (ref, data, auto): Promise<SaveDocumentResult> => {
      try {
        if (await changedExternally(ref)) {
          if (auto === true) return { ok: false, reason: 'external-modified' }
          if (!confirmOverwrite()) return { ok: false, reason: 'external-modified' }
        }
        // Checked before the write rather than caught after it, so an autosave that
        // cannot proceed is a reported outcome and not an exception mapped back into
        // one. A manual save falls through and lets the store ask.
        if (auto === true && !(await store.writable(ref))) {
          return { ok: false, reason: 'needs-permission' }
        }
        const bytes = new Uint8Array(data)
        await store.write(ref, bytes, { prompt: auto !== true })
        // Re-baseline from what we just wrote, or the next save would flag our own
        // write as somebody else's.
        await remember(ref, await sha256Hex(toArrayBuffer(bytes)))
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    saveAs: (defaultName, data) => saveNamed(store, remember, defaultName, data),

    /**
     * The "silent first save" that cannot be silent.
     *
     * Electron's `saveNew` writes into the host's default documents folder with
     * no dialog. A browser has no folder it may write to unasked, so the only
     * honest implementation is the Save As dialog — and a dialog the user did not
     * ask for is an interruption, however legal it is.
     *
     * So `auto` is what decides, and it decides first. An automatic save reports
     * `{ ok: false, reason: 'needs-user-gesture' }` without opening anything, and
     * the `reason` is the point: a bare `{ ok: false }` would be
     * indistinguishable from a dismissed dialog and the renderer would show
     * nothing at all, which is precisely the class of silent no-op the web shim
     * was deleted for. The discriminator lets the renderer say "not being
     * autosaved, because this document has nowhere to go yet".
     *
     * This used to gate on transient user activation instead, and that was the
     * bug: `navigator.userActivation.isActive` stays true for seconds after any
     * keystroke, so a document being typed into holds activation almost
     * continuously. The recovery tick reached this method every 30 seconds for a
     * never-saved document, found activation, and opened the Save As dialog —
     * over and over, on a timer, with nobody having asked to save. Activation
     * says a dialog *may* open; only the caller knows whether one *should*.
     *
     * The probe is still consulted for a deliberate save, where it is a genuine
     * pre-flight check: a manual save that arrives after its gesture expired (a
     * long serialization, a menu command routed through a promise) would have the
     * picker reject, and reporting the same honest reason beats an exception.
     */
    saveNew: async (defaultName, data, auto): Promise<SaveNamedDocumentResult> => {
      if (auto || !hasUserActivation()) return { ok: false, reason: 'needs-user-gesture' }
      return saveNamed(store, remember, defaultName, data)
    },

    /** No host-owned recovery location, and nothing that would read one; see the file header. */
    writeRecoveryCopy: async () => ({ ok: false }),

    /**
     * Neither half of the renderer's recovery tick can land anywhere in a browser:
     * there is no host-owned location for a copy, and naming a never-saved
     * document needs a dialog nobody asked for. Answering `false` stops the timer
     * at the source, which is worth more than the two refusals it saves — the tick
     * re-serialises the entire document before it discovers there is nowhere to put
     * it, so on web it was a full docx build every 30 seconds, thrown away.
     *
     * The user's protection against losing work here is the unload guard (see
     * `createWebDocsWindowPort`) plus `download` below, not a copy this host
     * cannot keep.
     */
    crashRecovery: false,

    /**
     * The store's own recent list, which survives a reload because the handles do.
     *
     * `location` is omitted: a handle exposes no path, and inventing one would put
     * a fiction in the recent list's tooltip.
     */
    recentDocuments: async (): Promise<RecentDocument[]> =>
      (await store.recent()).map(({ ref, name }) => ({ ref, name })),

    pickImage: async (): Promise<PickImageResult | null> => {
      let handle
      try {
        handle = await pickers.openFile({ types: IMAGE_FILE_TYPES, id: 'samugen-image' })
      } catch (error) {
        if (isPickerCancel(error)) return null
        throw error
      }
      await ensurePermission(handle, 'read')
      const file = await handle.getFile()
      const mime = imageMimeOf(file.name)
      // The dialog is filtered to png/jpeg/gif, so this is unreachable unless the
      // user defeats the filter; failing loudly beats returning a wrong mime.
      if (!mime) throw new Error(`${file.name} is not a PNG, JPEG or GIF image`)
      return { base64: toBase64(new Uint8Array(await file.arrayBuffer())), mime, name: file.name }
    },
  }
}

/**
 * docs' window integration for a browser.
 *
 * This is where the two hosts differ most, so it is worth being exact about which
 * members do work, which are subscriptions with no emissions, and why:
 *
 *   - `onCloseCheck` / `reportCloseCheck` **work**. The Electron protocol is a
 *     pull: the host asks at close time and the renderer answers once. A
 *     `beforeunload` listener is exactly that moment, and the question is
 *     synchronous — "would work be lost?" needs no I/O — so this host asks its
 *     subscribers from inside `beforeunload`, reads the reply, and shows the
 *     browser's "Leave site?" prompt only when the answer says the document is
 *     dirty. The reply must arrive before the handler returns, which is why
 *     `onCloseCheck` documents synchronous replies; App.tsx keeps its dirty state
 *     in refs and answers immediately. A subscriber that does not answer is
 *     treated as dirty — an extra prompt is recoverable, a discarded document is
 *     not.
 *
 *     Note what is *not* claimed: `autoSave` and `ref` from the reported state are
 *     read but unused here. Electron uses them to autosave silently on close and
 *     to clean up the recovery copy on "Don't Save". Neither is possible during
 *     unload (both are async writes), so this host uses only `dirty`.
 *
 *   - `onCloseSaveRequest` emits exactly when there is a host that can wait. In a
 *     standalone browser tab there is none, and that is a legitimate
 *     implementation rather than a gap swept under the carpet. Its contract is
 *     "save, then tell me how it went, and I will wait": the Electron host
 *     intercepts the close, awaits the renderer's save and only then closes.
 *     `beforeunload` cannot express that — the page may not await anything before
 *     the document goes away — so standalone there is no moment at which this
 *     host could honestly make that request. An event source with no events
 *     reports the truth and every subscriber keeps working; a method that
 *     pretended to save would tell the app the work was persisted when it was
 *     not. The user-visible consequence: the browser's leave prompt offers
 *     "leave" or "stay", not "save and leave".
 *
 *     Inside the web shell there *is* such a host. Closing a tab removes this
 *     frame, which the shell controls and can defer, so when a `FrameChildLink`
 *     is supplied both the close check and the close-save request become real —
 *     driven from the shell into the very same two subscriber sets. Nothing about
 *     the standalone build changes; it simply passes no link.
 *
 *   - `reportCloseSaveResult` is the reply half of that handshake. Standalone
 *     there are no requests, so it is unreachable by construction — the only
 *     caller is inside the `onCloseSaveRequest` handler — and it warns rather
 *     than returning silently, so a broken invariant is visible instead of
 *     swallowed. With a link it relays the outcome to the shell.
 *
 *   - `onTeardown` is a real subscription this host never emits for. Electron
 *     fires it when the shell detaches a tab's contents but keeps it alive, so
 *     background timers can stop. A browser has no such state: the page is either
 *     live or gone.
 *
 *   - `onMenuCommand` is a real subscription this host never emits for. There is
 *     no native application menu behind a web page. Every command it carries also
 *     has an in-app entry point (the ribbon, the keyboard shortcuts), so nothing
 *     becomes unreachable — except `export-pdf`, which this host cannot do at all
 *     (`pdfExport` is null) and whose ribbon entry is hidden for that reason.
 */
export function createWebDocsWindowPort(
  installUnloadPrompt: typeof createWebUnloadPrompt = createWebUnloadPrompt,
  frame: FrameChildLink | null = null,
): DocsWindowPort {
  const closeCheckListeners = new Set<() => void>()
  const closeSaveListeners = new Set<() => void>()
  /**
   * Mailbox for the reply to the request currently in flight.
   *
   * A queue rather than a single variable so the reply is *taken* rather than
   * read: an emptied-then-read variable is narrowed to `undefined` by the
   * compiler, since it cannot see that the listener call in between writes to it.
   * `shift()` is honest about the same fact at the type level.
   */
  const replies: CloseCheckState[] = []

  /** Ask every subscriber, synchronously, whether closing would lose work. */
  const wouldLoseWork = (): boolean => {
    if (closeCheckListeners.size === 0) return false
    for (const listener of closeCheckListeners) {
      replies.length = 0
      listener()
      const reply = replies.shift()
      // No reply, or a dirty one: prompt. Treating silence as dirty is the safe
      // direction, and it also means a subscriber that starts replying
      // asynchronously degrades to an extra prompt, never to lost work.
      if (reply === undefined || reply.dirty) {
        replies.length = 0
        return true
      }
    }
    replies.length = 0
    return false
  }

  installUnloadPrompt(wouldLoseWork)

  if (frame !== null) {
    // The shell's close check asks the same question the unload guard does, of
    // the same subscribers, so a tab close and a window close cannot disagree.
    frame.onCloseCheck(wouldLoseWork)
    frame.onCloseSave(() => {
      if (closeSaveListeners.size === 0) {
        // Nobody is listening, so nothing will ever reply. Say so now rather
        // than let the shell wait out its deadline and reach the same answer.
        frame.reportCloseSave(false)
        return
      }
      for (const listener of closeSaveListeners) listener()
    })
  }

  return {
    // A browser draws neither the window frame nor a menu bar. The ribbon reads
    // this to keep its File menu in-app on every platform — keyed on the OS
    // alone it would vanish on macOS, taking Open, Save As and Export with it —
    // and to stop reserving space for window controls that do not exist here.
    nativeChrome: false,
    onCloseCheck(handler: () => void): () => void {
      closeCheckListeners.add(handler)
      return () => void closeCheckListeners.delete(handler)
    },
    reportCloseCheck(state: CloseCheckState): void {
      replies.push(state)
    },
    onCloseSaveRequest(handler: () => void): () => void {
      closeSaveListeners.add(handler)
      return () => void closeSaveListeners.delete(handler)
    },
    reportCloseSaveResult: (ok: boolean) => {
      if (frame !== null) {
        frame.reportCloseSave(ok)
        return
      }
      console.warn(
        `[docs] close-save result (${ok}) reported, but this host never issues a close-save ` +
          `request. Something is calling the reply half of the handshake directly.`,
      )
    },
    onTeardown: () => () => {},
    onMenuCommand: () => () => {},
  }
}

/**
 * The browser's print flow, which is `window.print()` and nothing else.
 *
 * This is the one capability the *web* host has and the Electron one does not
 * (see `DocsPlatform.print`), and it is deliberately thin: the paper size, the
 * one-page-per-sheet layout and the hidden app chrome are all CSS, decided by the
 * renderer, because only the renderer knows the document's section geometry.
 * `window.print()` takes no arguments — there is nothing for this adapter to
 * pass — so all it owns is *when the print is over*.
 *
 * That is what the promise is for. `window.print()` happens to block on a nested
 * event loop in every browser that implements it, but the spec does not require
 * it to, and `afterprint` is the defined signal. Waiting on the event means a
 * caller that tears something down afterwards cannot tear it down out from under
 * a live print job on whatever browser decides to return early. Cancelling fires
 * `afterprint` too, which is why the promise carries no outcome: from here,
 * printed and cancelled are the same event.
 */
export function createWebDocsPrintPort(
  printPage: () => void = () => window.print(),
): DocsPrintPort {
  return {
    print: () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.removeEventListener('afterprint', done)
          resolve()
        }
        window.addEventListener('afterprint', done)
        printPage()
      }),
  }
}

export function createWebDocsPlatform(deps: WebDocsPlatformDeps): DocsPlatform {
  return {
    language: deps.language,
    ai: deps.ai,
    attachments: deps.attachments,
    window: createWebDocsWindowPort(deps.unloadPrompt, deps.frame ?? null),
    file: createWebDocsFilePort(
      deps.store,
      deps.pickers,
      deps.hasUserActivation,
      deps.confirmOverwrite,
    ),
    // The four capabilities a browser cannot back. Each is `null` rather than a
    // stub, so the UI that offers them is hidden instead of inert — see
    // DocsPlatform in platform.ts for the reason behind each one.
    tabs: null,
    search: null,
    // Still null after Phase 4c, and permanently: PDF *export* writes a file the
    // renderer would have to draw itself, and a rasterised or re-laid-out
    // approximation under the same command name would misreport what happened.
    // The browser prints instead — a different operation, offered under its own
    // name through the port below.
    pdfExport: null,
    hwpx: createWebDocsHwpxPort(deps.store),
    print: createWebDocsPrintPort(deps.printPage),
    // Non-null exactly where Electron's is null. On the desktop Save As is the
    // better command; here it is the only way a document with no handle — a new
    // one, or a converted `.hwpx` — can leave the page at all.
    download: createWebDocsDownloadPort(deps.deliverDownload),
  }
}

/** The docx media type, for the Blob a download is delivered as. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Download the open document as `.docx`.
 *
 * Deliberately does not go near the store: no handle, no ref, no permission
 * grant, no entry in the recent list. It is a copy of the bytes the editor would
 * have saved, handed to the browser, and the document it came from is untouched —
 * still dirty if it was dirty, still pointing at whatever it was pointing at.
 *
 * That is also why it cannot report whether the file reached the disk. The
 * browser may put it straight in the downloads folder or ask the user where it
 * goes, and a page is told neither outcome. `ok: true` means handed over, and the
 * status message the renderer shows says exactly that much.
 */
export function createWebDocsDownloadPort(deliver: DownloadDelivery): DocsDownloadPort {
  return {
    download: async (defaultName, data): Promise<DownloadResult> => {
      // A document opened from a `.hwpx` is a `.docx` from here on (the import
      // becomes an unsaved docx), and a name is all this port has to go on, so the
      // extension is corrected rather than trusted.
      const name = /\.docx$/i.test(defaultName)
        ? defaultName
        : `${defaultName.replace(/\.[^./\\]*$/, '')}.docx`
      try {
        deliver(name, data, DOCX_MIME)
        return { ok: true, name }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/**
 * HWPX export, entirely in the browser.
 *
 * Non-null here, unlike `pdfExport`, and the two are not alike. A browser-side
 * PDF exporter would have to re-render the document and would produce something
 * *different* from what the desktop writes under the same command name. This
 * runs the very same converter the Electron host runs: @samugen/hwpx-convert
 * assembles the package from an embedded template, so there is no filesystem on
 * the path and no second implementation to diverge.
 *
 * Written through `saveBytesAs`, which deliberately mints no ref: an export is
 * an artifact the user takes away, not a document this app goes on editing, so
 * the `.docx` it came from stays the open document.
 */
export function createWebDocsHwpxPort(store: WebDocumentStore): DocsHwpxPort {
  return {
    exportDocument: async (defaultName, html): Promise<HwpxExportResult> => {
      try {
        // On demand: the converter is the heaviest thing in this bundle, and a
        // session that never exports should not download it.
        const { htmlToHwpx } = await import('@samugen/hwpx-convert')
        const bytes = await htmlToHwpx(html)
        const suggested = `${defaultName.replace(/\.docx$/i, '')}.hwpx`
        const written = await store.saveBytesAs(suggested, bytes, HWPX_FILE_TYPES)
        // A dismissed dialog is `ok: false` with no error, matching the PDF
        // export port's convention; the caller reports it as a cancellation.
        if (written === null) return { ok: false }
        // A browser gives a name, never a path. `path` is display-only, and the
        // name is the most honest thing to put in it.
        return { ok: true, path: written }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
  }
}

/**
 * A save that had to name the document: pick a destination, write, adopt it, and
 * record the disk baseline so the next in-place save can detect a conflict.
 *
 * A dismissed dialog is `{ ok: false }` with no error and no reason — the port's
 * shape for "cancelled", which the renderer reports silently.
 */
async function saveNamed(
  store: WebDocumentStore,
  remember: (ref: DocumentRef, hash: string) => Promise<void>,
  defaultName: string,
  data: ArrayBuffer,
): Promise<SaveNamedDocumentResult> {
  try {
    const bytes = new Uint8Array(data)
    const saved = await store.saveAsDocument(withDocxExtension(defaultName), bytes)
    if (saved === null) return { ok: false }
    await remember(saved.ref, await sha256Hex(toArrayBuffer(bytes)))
    return { ok: true, ref: saved.ref, name: saved.name }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * The suggested name a save dialog opens with.
 *
 * The renderer's default name can be a bare title (`deriveAutoFileName` builds
 * one from the first heading), and a browser save dialog uses the suggested name
 * verbatim — so without this the user would be offered an extension-less file
 * that Word will not open.
 */
function withDocxExtension(name: string): string {
  return /\.docx$/i.test(name) ? name : `${name}.docx`
}

const IMAGE_MIME_BY_EXT: Record<string, PickImageResult['mime']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

function imageMimeOf(name: string): PickImageResult['mime'] | undefined {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? IMAGE_MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] : undefined
}

/**
 * `OpenedDocument.data` is declared as an `ArrayBuffer` because that is what the
 * Electron IPC channel hands back. Copying the view's own bounds out keeps the
 * two hosts' results identical even when the store returns a view over a larger
 * pooled buffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** sha256 as lowercase hex, matching the main process's `sha256Hex`. */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Bytes → raw base64, without the `data:` prefix. Chunked: spreading megabytes blows the argument limit. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
