/**
 * The shell's platform slot: the one place the renderer names the host capabilities it needs, and
 * the only thing renderer code is allowed to reach the host through.
 */
import { createPlatformSlot, type LanguagePort } from '@samugen/platform'
import type { AiSettingsApi } from '../../shared/ai-settings-api'
import type { ProjectSummaryEntry, RecentQuery } from '../../shared/home-api'
import type { TabsApi, TabSummary } from '../../shared/tabs-api'

/** Opaque handle to one file the host knows about, issued by the host. */
export type FileRef = string

/** One row of the Home file lists: the handle, plus everything the row renders. */
export interface FileEntry {
  ref: FileRef
  /** Display name including the extension, e.g. `report.docx`. */
  name: string
  /** Lowercased extension without the dot; drives the file-type badge and the type filter. */
  ext: string
  /** Last-modified time, ms since epoch. */
  mtimeMs: number
  sizeBytes: number
  starred: boolean
  /**
   * Display name of the containing folder — the Location column — or undefined when the host has
   * none.
   */
  folder?: string
  /**
   * Full human-readable location, for display only ("Copy path"), or undefined when the host has
   * none.
   */
  location?: string
}

/** One page of a Home list, with the totals the sidebar counters and the loader need. */
export interface FilePage {
  entries: FileEntry[]
  /** Total matching the query's `ext` filter. */
  total: number
  /** Total ignoring the `ext` filter. */
  totalAll: number
}

/** Outcome of renaming a file. */
export interface RenameFileResult {
  ok: boolean
  error?: string
}

/** The Home file lists and the operations on their rows. */
export interface ShellFilesPort {
  /** Recently opened files across every document type, newest first. */
  recents(query?: RecentQuery): Promise<FilePage>
  /** Starred files, independent of the recent list, newest first. */
  starred(query?: RecentQuery): Promise<FilePage>
  /**
   * Metadata for a specific set of refs (the project files view); refs the host
   * can no longer resolve are dropped rather than reported.
   */
  statFiles(refs: FileRef[]): Promise<FileEntry[]>
  toggleStar(ref: FileRef): Promise<void>
  /** Drop entries from the recent list; the files themselves are untouched. */
  removeRecent(refs: FileRef[]): Promise<void>
  /** Rename in place. `newName` includes the extension. */
  rename(ref: FileRef, newName: string): Promise<RenameFileResult>
  /** Copy the file beside itself under a localized "copy" suffix, and record it as recent. */
  duplicate(ref: FileRef): Promise<void>
  /** Move files to the host's trash and drop them from the recent list. */
  deleteFiles(refs: FileRef[]): Promise<void>
  /** Show the file in the host's file manager, or `null` on a host that has none. */
  reveal: ((ref: FileRef) => Promise<void>) | null
}

/** Where a newly created document should land. */
export interface NewDocumentOptions {
  /** Add the new file to this project; omitted when no project is selected. */
  projectId?: string
}

/** Opening editor surfaces from Home. */
export interface ShellLauncherPort {
  /** Open an existing file, routed to the right editor by its type. */
  open(ref: FileRef): Promise<void>
  newDoc(options?: NewDocumentOptions): Promise<void>
}

/** Creating spreadsheet documents. */
export interface ShellSheetsLauncherPort {
  newSheet(options?: NewDocumentOptions): Promise<void>
}

/** Creating presentations. Backed by both hosts: apps/slides has an Electron and a web build. */
export interface ShellSlidesLauncherPort {
  newSlide(options?: NewDocumentOptions): Promise<void>
}

/**
 * The shell's own "open a file" picker: pick anywhere on the machine, then route the result to the
 * editor that handles its type.
 */
export interface ShellBrowsePort {
  /** Host file picker accepting every supported type, then routes to the editor. */
  browse(): Promise<void>
}

/** Opening a pdf surface with no document in it. */
export interface ShellPdfLauncherPort {
  newPdfTab(): Promise<void>
}

/** Projects: the Home sidebar's grouping of files. */
export interface ShellProjectsPort {
  list(): Promise<ProjectSummaryEntry[]>
  listFiles(projectId: string): Promise<FileRef[]>
  create(name: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Soft-delete; the files stay where they are. */
  delete(id: string): Promise<void>
  moveFile(ref: FileRef, projectId: string): Promise<void>
}

/** UI language: the shared `LanguagePort`, all three members. */
export type ShellLanguagePort = LanguagePort

/** The first-run tour's one piece of host state. */
export interface ShellOnboardingPort {
  /** Whether the tour has been completed or skipped. */
  seen(): Promise<boolean>
  /** Record that it has; it never shows again. */
  markSeen(): Promise<void>
}

/** The application itself, as the account menu and the tour present it. */
export interface ShellAppPort {
  /** Version string for the account menu's footer row. */
  version(): Promise<string>
}

/** The tab strip, minus the two native menus. */
export type ShellTabsPort = Pick<TabsApi, 'list' | 'activate' | 'close' | 'reorder' | 'onChanged'>

/** The two native popup menus behind the "+" and "all tabs" buttons. */
export type ShellTabMenusPort = Pick<TabsApi, 'showMenu' | 'showNewMenu'>

/** Reading the AI provider configuration. */
export type ShellAiSettingsPort = Pick<AiSettingsApi, 'get'>

/**
 * Editing the AI provider configuration: saving a provider, probing a model, cancelling a probe.
 */
export type ShellAiSettingsEditorPort = Pick<AiSettingsApi, 'save' | 'test' | 'cancelTest'>

/** What the shell does with a tab whose editor reports unsaved work. */
export type ShellCloseDecision = 'close' | 'keep'

/** The close guard's question, handed to the renderer's prompt. */
export interface ShellCloseRequest {
  /** The tab being closed, for the prompt's wording. */
  tab: TabSummary
  /** Ask the editor to save now; resolves to whether it succeeded. */
  save(): Promise<boolean>
}

/** Hosting editor surfaces as in-page frames. */
export interface ShellFramesPort {
  /** The URL a tab's frame should load, or `null` for a tab that has no frame (Home). */
  srcFor(tab: TabSummary): string | null
  /** Attach the rendered iframe for a tab, or `null` when it unmounts. */
  register(id: string, frame: HTMLIFrameElement | null): void
  /** Install the renderer's unsaved-changes prompt. Called once, before any close. */
  setClosePrompt(prompt: (request: ShellCloseRequest) => Promise<ShellCloseDecision>): void
}

/** The shell's composed platform (the `index.html` document). */
export interface ShellPlatform {
  language: ShellLanguagePort
  app: ShellAppPort
  onboarding: ShellOnboardingPort
  files: ShellFilesPort
  launcher: ShellLauncherPort
  sheetsLauncher: ShellSheetsLauncherPort | null
  slidesLauncher: ShellSlidesLauncherPort | null
  browse: ShellBrowsePort | null
  pdfLauncher: ShellPdfLauncherPort | null
  frames: ShellFramesPort | null
  projects: ShellProjectsPort | null
  tabs: ShellTabsPort
  tabMenus: ShellTabMenusPort | null
  aiSettings: ShellAiSettingsPort
  aiSettingsEditor: ShellAiSettingsEditorPort | null
}

/** What a host module must export as `createShellPlatform`. */
export type CreateShellPlatform = () => Promise<ShellPlatform>

export const { set: setShellPlatform, get: shellPlatform } =
  createPlatformSlot<ShellPlatform>('shell')
