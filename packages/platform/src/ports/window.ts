/**
 * Window / tab lifecycle capability: opening and switching editor surfaces,
 * plus the close-guard handshake every editor takes part in.
 *
 * Every member is required. The table records which preloads currently forward
 * each channel:
 *
 * | method                | pdf | docs | slides | sheets |
 * | --------------------- | --- | ---- | ------ | ------ |
 * | openNewTab            | no  | yes  | no     | no     |
 * | listTabs              | no  | yes  | no     | no     |
 * | focusTab              | no  | yes  | no     | no     |
 * | setDirty              | yes | no   | no     | via notifyPendingEdits(count) |
 * | onCloseSaveRequest    | yes | yes  | yes    | yes    |
 * | reportCloseSaveResult | yes (as sendCloseSaveResult) | yes | yes | yes |
 *
 * The tab channels ('win:new' / 'win:list' / 'win:focus') are registered by
 * docs-main and the shell's tab manager owns the actual tab strip for every
 * app, so a shell-hosted adapter for any app can forward them. Standalone
 * windows are the exception, and pdf is one: `startPdfStandalone()`
 * (apps/pdf/src/main/pdf-main.ts:549) registers only `registerPdfIpc()` and has
 * no tab strip, so pdf composes a `Pick` of this port (setDirty plus the close
 * guard) instead of claiming all of it. Same reasoning as the AI split — see
 * ports/ai.ts.
 *
 * Naming note: apps/pdf calls the close-guard reply `sendCloseSaveResult`;
 * docs, slides and sheets call it `reportCloseSaveResult`. Same signature, so
 * the port adopts the three-app majority name.
 *
 * Dirty-state note: pdf mirrors a boolean (`setDirty`) while sheets mirrors a
 * pending-edit count (`notifyPendingEdits`). The port keeps the boolean as the
 * shared contract; a sheets adapter maps `count > 0` onto it and keeps its own
 * badge count locally.
 *
 * Deliberately excluded (single-app, so not a shared capability yet): docs'
 * onCloseCheck / reportCloseCheck / onTeardown, and slides' setAutoSavePref /
 * isDirty. docs' reportCloseCheck additionally carries `autoSave` and
 * `filePath`, which the boolean cannot express — see the Phase 1 report.
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
   * A null / omitted path opens a blank document.
   */
  openNewTab(openPath?: string | null): Promise<void>
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
