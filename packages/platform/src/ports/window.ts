/**
 * Window / tab lifecycle capability: opening and switching editor surfaces, plus the close-guard
 * handshake every editor takes part in.
 */

/** One open editor tab, for the "switch tab" menu. */
export interface TabInfo {
  id: string
  title: string
  focused: boolean
}

export interface WindowPort {
  /** Open another tab of the current app, optionally loading a document. */
  openNewTab(openRef?: string | null): Promise<void>
  /** All open tabs of the current app. */
  listTabs(): Promise<TabInfo[]>
  focusTab(id: string): Promise<void>
  /** Mirror unsaved-changes state to the host; drives the save prompt on close. */
  setDirty(dirty: boolean): void
  /** The host's close guard chose "Save": run the full save flow, then reply. */
  onCloseSaveRequest(handler: () => void): () => void
  reportCloseSaveResult(ok: boolean): void
}
