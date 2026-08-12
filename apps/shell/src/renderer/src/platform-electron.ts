/**
 * Builds the shell's platforms from the Electron preload bridges
 * (`window.aiOffice`, `window.aiOfficeTabs`, `window.aiOfficeProject`,
 * `window.aiOfficeAiSettings`, and `window.aiOfficeUpdate` in the update
 * window). Nothing in this file talks to Electron or to `window` directly: every
 * bridge is passed in, so the globals are read in exactly one place —
 * host-electron.ts — and these adapters stay unit-testable against a fake.
 *
 * Electron's `FileRef` *is* the absolute path, so most of the mapping is a
 * rename. This adapter is the only place allowed to read a ref as a path — that
 * is what makes it the Electron adapter — which is also where every display name
 * comes from, since the renderer must not parse a ref itself. `parentDir` below
 * moved here verbatim from Home.tsx for exactly that reason.
 *
 * Unlike apps/pdf and apps/docs, none of these adapters live in
 * @genoffice/platform-electron. That package holds the *shared* ports, and the
 * shell shares none: every bridge here is exposed by the shell's preload alone
 * and has no counterpart in any editor app (see the header of platform.ts for
 * the port-by-port reasoning). Putting them there would make the package depend
 * on one app's contract while pretending to be shared.
 */
import type { Lang } from '@genoffice/i18n'
import type { AiSettingsApi } from '../../shared/ai-settings-api'
import type { HomeApi, ProjectHomeApi, RecentEntry, RecentPage } from '../../shared/home-api'
import type { TabsApi } from '../../shared/tabs-api'
import type { UpdateWindowApi } from '../../shared/update-api'
import type {
  FileEntry,
  FilePage,
  ShellAccountPort,
  ShellAiSettingsEditorPort,
  ShellAiSettingsPort,
  ShellAppPort,
  ShellFilesPort,
  ShellLanguagePort,
  ShellLauncherPort,
  ShellOnboardingPort,
  ShellPlatform,
  ShellProjectsPort,
  ShellTabMenusPort,
  ShellTabsPort,
  UpdateWindowPlatform,
} from './platform'

/**
 * Display name of the folder containing an absolute path.
 *
 * The Location column's value. It used to be computed in Home.tsx, which made
 * the renderer a path parser; here it is the host answering a question only the
 * host can answer.
 */
function parentDir(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 2] ?? ''
}

/**
 * Bridge row → port row: the path becomes the ref and both display fields.
 *
 * `location` is the absolute path because this host has one, so "Copy path" and
 * any tooltip keep showing exactly what they always showed.
 */
function toFileEntry(entry: RecentEntry): FileEntry {
  return {
    ref: entry.path,
    name: entry.name,
    ext: entry.ext,
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
    starred: entry.starred,
    folder: parentDir(entry.path),
    location: entry.path,
  }
}

function toFilePage(page: RecentPage): FilePage {
  return { entries: page.entries.map(toFileEntry), total: page.total, totalAll: page.totalAll }
}

/** The Home file lists over the Electron bridge. */
export function createShellFilesPort(bridge: HomeApi): ShellFilesPort {
  return {
    recents: async (query) => toFilePage(await bridge.recents(query)),
    starred: async (query) => toFilePage(await bridge.starred(query)),
    statFiles: async (refs) => (await bridge.statPaths(refs)).map(toFileEntry),
    toggleStar: (ref) => bridge.toggleStar(ref),
    removeRecent: (refs) => bridge.removeRecent(refs),
    // The bridge also reports the new path; the port drops it because no caller
    // reads it, and a path is not something the renderer may hold anyway.
    rename: async (ref, newName) => {
      const result = await bridge.renameFile(ref, newName)
      return { ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) }
    },
    duplicate: (ref) => bridge.duplicateFile(ref),
    deleteFiles: (refs) => bridge.deleteFiles(refs),
    // Non-null because this host really does have a file manager to reveal in.
    reveal: (ref) => bridge.revealPath(ref),
  }
}

/** Opening editor surfaces over the Electron bridge (the main process owns the tab strip). */
export function createShellLauncherPort(bridge: HomeApi): ShellLauncherPort {
  return {
    open: (ref) => bridge.openPath(ref),
    browse: () => bridge.browse(),
    newDoc: (options) => bridge.newDoc(options),
    newSheet: (options) => bridge.newSheet(options),
    newSlide: (options) => bridge.newSlide(options),
  }
}

/**
 * Projects over the Electron bridge, or `null` when this renderer is loaded
 * outside the shell and the bridge was never exposed.
 *
 * The `undefined` check is the same one Home.tsx used to make inline; moving it
 * here is what turns "is the global there?" into a typed capability.
 */
export function createShellProjectsPort(
  bridge: ProjectHomeApi | undefined,
): ShellProjectsPort | null {
  if (!bridge) return null
  return {
    list: () => bridge.listProjects(),
    // The bridge answers with absolute paths; they become refs here and are
    // opaque from this line on. They used to travel through the renderer as
    // paths on their way to statPaths.
    listFiles: (projectId) => bridge.listFiles(projectId),
    create: async (name) => {
      await bridge.createProject(name)
    },
    rename: (id, name) => bridge.renameProject(id, name),
    delete: (id) => bridge.deleteProject(id),
    moveFile: (ref, projectId) => bridge.moveFile(ref, projectId),
  }
}

/** The account entry over the Electron bridge (Genspark sign-in via the gsk CLI). */
export function createShellAccountPort(bridge: HomeApi): ShellAccountPort {
  return {
    status: () => bridge.accountStatus(),
    login: () => bridge.accountLogin(),
    onLoginProgress: (handler) => bridge.onAccountLogin(handler),
    openLoginUrl: () => bridge.openLoginUrl(),
    logout: () => bridge.accountLogout(),
  }
}

/** UI language over the Electron bridge; the main process persists it and rebuilds its menus. */
export function createShellLanguagePort(bridge: HomeApi): ShellLanguagePort {
  return {
    // The bridge's own union is the same 19 languages as `Lang`, so this is a
    // widening rename rather than a conversion.
    getLanguage: () => bridge.getLanguage(),
    setLanguage: (lang: Lang) => bridge.setLanguage(lang),
  }
}

/** The first-run flag over the Electron bridge (persisted in userData/app-settings.json). */
export function createShellOnboardingPort(bridge: HomeApi): ShellOnboardingPort {
  return {
    seen: () => bridge.onboardingSeen(),
    markSeen: () => bridge.setOnboardingSeen(),
  }
}

/** App version and the community link over the Electron bridge. */
export function createShellAppPort(bridge: HomeApi): ShellAppPort {
  return {
    version: () => bridge.getAppVersion(),
    openGenTeam: () => bridge.openGenTeam(),
  }
}

/** The tab strip over the Electron bridge, minus the two native menus. */
export function createShellTabsPort(bridge: TabsApi): ShellTabsPort {
  return {
    list: () => bridge.list(),
    activate: (id) => bridge.activate(id),
    close: (id) => bridge.close(id),
    reorder: (id, toIndex) => bridge.reorder(id, toIndex),
    onChanged: (handler) => bridge.onChanged(handler),
  }
}

/**
 * The native tab menus over the Electron bridge.
 *
 * Non-null because this host both needs them and has them: the content area is a
 * WebContentsView that would paint over a DOM dropdown.
 */
export function createShellTabMenusPort(bridge: TabsApi): ShellTabMenusPort {
  return {
    showMenu: (x, y) => bridge.showMenu(x, y),
    showNewMenu: (x, y) => bridge.showNewMenu(x, y),
  }
}

/** Reading the AI provider configuration over the Electron bridge. */
export function createShellAiSettingsPort(bridge: AiSettingsApi): ShellAiSettingsPort {
  return { get: () => bridge.get() }
}

/**
 * Editing the AI provider configuration over the Electron bridge.
 *
 * Non-null because this host owns a credential store: the writes land in
 * @genoffice/ai-electron behind Electron's `safeStorage`.
 */
export function createShellAiSettingsEditorPort(bridge: AiSettingsApi): ShellAiSettingsEditorPort {
  return {
    save: (input) => bridge.save(input),
    test: (input) => bridge.test(input),
    cancelTest: () => bridge.cancelTest(),
  }
}

/** The bridges the shell window's platform is built from. */
export interface ShellBridges {
  home: HomeApi
  tabs: TabsApi
  aiSettings: AiSettingsApi
  /** Absent when this renderer is loaded outside the shell; see `createShellProjectsPort`. */
  project: ProjectHomeApi | undefined
}

/**
 * All three nullable capabilities are non-null here, which is what makes the
 * desktop app's behaviour identical to before the seam existed: the main process
 * owns the file manager, the native menus and the credential store.
 */
export function createElectronShellPlatform(bridges: ShellBridges): ShellPlatform {
  return {
    language: createShellLanguagePort(bridges.home),
    app: createShellAppPort(bridges.home),
    onboarding: createShellOnboardingPort(bridges.home),
    files: createShellFilesPort(bridges.home),
    launcher: createShellLauncherPort(bridges.home),
    projects: createShellProjectsPort(bridges.project),
    account: createShellAccountPort(bridges.home),
    tabs: createShellTabsPort(bridges.tabs),
    tabMenus: createShellTabMenusPort(bridges.tabs),
    aiSettings: createShellAiSettingsPort(bridges.aiSettings),
    aiSettingsEditor: createShellAiSettingsEditorPort(bridges.aiSettings),
  }
}

/**
 * The update window's platform.
 *
 * A pass-through: `UpdateWindowApi` is already transport-agnostic, so the port
 * aliases it and this adapter exists only so the update renderer reads the slot
 * rather than the global, like every other renderer file.
 */
export function createElectronUpdateWindowPlatform(bridge: UpdateWindowApi): UpdateWindowPlatform {
  return { update: bridge }
}
