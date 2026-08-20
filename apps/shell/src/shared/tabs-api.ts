export type TabKind = 'home' | 'docs' | 'sheets' | 'slides' | 'pdf'

/** one open tab in the top tab strip; Home is always id 'home' and not closable */
export interface TabSummary {
  id: string
  kind: TabKind
  title: string
  closable: boolean
  active: boolean
}

export interface TabsApi {
  list(): Promise<TabSummary[]>
  activate(id: string): Promise<void>
  close(id: string): Promise<void>
  /** pop up the native "all tabs" list menu at (x, y) in window CSS coordinates. */
  showMenu(x: number, y: number): Promise<void>
  /**
   * pop up the native "+" new-file menu (new doc/sheet/slides, open local file) at (x, y) in window
   * CSS coordinates.
   */
  showNewMenu(x: number, y: number): Promise<void>
  /** move a tab to a new index in the strip; Home stays pinned at index 0 */
  reorder(id: string, toIndex: number): Promise<void>
  /** subscribe to tab list changes (open/close/activate/title updates); returns unsubscribe */
  onChanged(handler: (tabs: TabSummary[]) => void): () => void
}

export const TABS_CHANNELS = {
  list: 'tabs:list',
  activate: 'tabs:activate',
  close: 'tabs:close',
  showMenu: 'tabs:show-menu',
  showNewMenu: 'tabs:show-new-menu',
  reorder: 'tabs:reorder',
  changed: 'tabs:changed',
} as const
