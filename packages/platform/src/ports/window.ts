/**
 * Window / tab lifecycle capability: opening and switching editor surfaces, plus the
 * close-guard handshake every editor takes part in.
 *
 * Every member is required, and not every app claims the whole port. In a browser the
 * tab strip belongs to the shell, and an editor only has one when it is hosted as a
 * frame of it — so an app served standalone composes a `Pick` of this port (the dirty
 * flag plus the close guard) rather than claiming tab channels nothing answers. pdf is
 * the app that does so unconditionally.
 *
 * Dirty-state note: pdf mirrors a boolean (`setDirty`) while sheets mirrors a
 * pending-edit count (`notifyPendingEdits`). The port keeps the boolean as the shared
 * contract; a sheets adapter maps `count > 0` onto it and keeps its own badge count
 * locally.
 *
 * Deliberately excluded (single-app, so not a shared capability): docs'
 * onCloseCheck / reportCloseCheck / onTeardown, and slides' setAutoSavePref / isDirty.
 *
 * The docs close-check pair is excluded for a stronger reason than "only one app has
 * it": it is a different protocol. `setDirty` is a push — the renderer tells the host
 * whenever the state changes, and the host remembers. docs' pair is a pull — the host
 * asks at close time and the renderer answers once, with a three-field decision
 * (`dirty`, `autoSave`, and the document handle) that drives the silent
 * autosave-on-close path. Neither direction can be derived from the other, so docs
 * declares its own close-guard port (apps/docs/src/renderer/platform.ts) and reuses
 * only the save-request / save-result half from here, which really is shared by all
 * four apps.
 */

/** One open editor tab, for the "switch tab" menu. */
export interface TabInfo {
  id: string
  title: string
  focused: boolean
}

export interface WindowPort {
  /**
   * Open another tab of the current app, optionally loading a document.
   * A null / omitted handle opens a blank document.
   *
   * `openRef` is an opaque handle the host itself issued (Electron's is an
   * absolute path); the renderer only relays back what it was given. Named for
   * that rather than `openPath`, so no caller is invited to build one.
   */
  openNewTab(openRef?: string | null): Promise<void>
  /**
   * All open tabs of the current app.
   *
   * Signature note: apps/shell's own TabsApi.list() returns a richer
   * TabSummary (kind / closable / active) covering every app's tabs. That is a
   * shell-only, cross-app view; this port stays with the per-app renderer shape.
   */
  listTabs(): Promise<TabInfo[]>
  focusTab(id: string): Promise<void>
  /** Mirror unsaved-changes state to the host; drives the save prompt on close. */
  setDirty(dirty: boolean): void
  /** The host's close guard chose "Save": run the full save flow, then reply. */
  onCloseSaveRequest(handler: () => void): () => void
  reportCloseSaveResult(ok: boolean): void
}
