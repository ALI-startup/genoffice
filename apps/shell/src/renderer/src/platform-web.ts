/** Builds the shell's platform for a browser. */
import type { LanguagePort } from '@samugen/platform'
import type { PublicAiSettings, ShellFrameLink } from '@samugen/platform-web'
import { FRAME_ID_PARAM } from '@samugen/platform-web'
import type { AiProviderConfigView, AiSettingsSnapshot } from '../../shared/ai-settings-api'
import { AI_PROVIDER_DEFINITIONS } from '../../shared/ai-settings-api'
import type { TabKind, TabSummary } from '../../shared/tabs-api'
import type {
  FilePage,
  FileRef,
  ShellAiSettingsPort,
  ShellAppPort,
  ShellCloseDecision,
  ShellCloseRequest,
  ShellFilesPort,
  ShellFramesPort,
  ShellLanguagePort,
  ShellLauncherPort,
  ShellOnboardingPort,
  ShellPdfLauncherPort,
  ShellSheetsLauncherPort,
  ShellSlidesLauncherPort,
  ShellPlatform,
  ShellTabsPort,
} from './platform'

/** The Home tab's fixed id, as in the Electron tab manager. */
const HOME_ID = 'home'

/** Where each editor is served, relative to the shell's own origin. */
export const WEB_APP_PATHS: Record<WebFrameKind, string> = {
  docs: '/app/docs/',
  pdf: '/app/pdf/',
  slides: '/app/slides/',
  sheets: '/app/sheets/',
}

/** The tab kinds this host can actually show. */
export type WebFrameKind = 'docs' | 'pdf' | 'slides' | 'sheets'

/** Is this a tab kind this host can host a frame for? */
export function isWebFrameKind(kind: TabKind): kind is WebFrameKind {
  return kind === 'docs' || kind === 'pdf' || kind === 'slides' || kind === 'sheets'
}

/** How often the shell re-reads its frames' document titles. */
export const TITLE_POLL_MS = 400

/** The route → tab mapping, as it appears in the address bar. */
export const ROUTE_HOME = '#/'

/** The history surface the router needs; injected so routing is testable. */
export interface RouteEnv {
  hash(): string
  push(hash: string): void
  replace(hash: string): void
  /** Subscribe to Back/Forward; returns an unsubscribe. */
  onChange(handler: () => void): () => void
}

/** A scheduler for the title poll. Returns a stop function. */
export type Scheduler = (tick: () => void, ms: number) => () => void

interface WebTab {
  id: string
  kind: TabKind
  /** Last title we showed. Frame tabs adopt their document's title as it loads. */
  title: string
}

/** Route text for a tab: `#/` for Home, `#/<kind>/<id>` for everything else. */
export function routeFor(tab: { id: string; kind: TabKind }): string {
  return tab.id === HOME_ID ? ROUTE_HOME : `#/${tab.kind}/${tab.id}`
}

/** Parse a route back into the tab it names. */
export function parseRoute(hash: string): { id: string; kind: TabKind } | null {
  const match = /^#\/(docs|pdf|slides|sheets)\/([A-Za-z0-9]+)$/.exec(hash)
  if (match === null) return null
  return { kind: match[1] as TabKind, id: match[2] }
}

export interface WebShellTabsDeps {
  route: RouteEnv
  frames: ShellFrameLink
  /** Localised placeholder title for a tab whose frame has not named itself yet. */
  titleFor: (kind: TabKind) => string
  /** Localised title of the Home tab. */
  homeTitle: string
  schedule: Scheduler
}

/**
 * The tab strip, the frames it hosts, and the routing that keeps the address bar honest about which
 * one is showing.
 */
export function createWebShellTabs(deps: WebShellTabsDeps): {
  tabs: ShellTabsPort
  frames: ShellFramesPort
  /** Open a new frame tab of the given kind and activate it; returns its id. */
  openTab(kind: WebFrameKind): string
  /** Stop the title poll and the route subscription. */
  dispose(): void
} {
  const tabs: WebTab[] = [{ id: HOME_ID, kind: 'home', title: deps.homeTitle }]
  let activeId = HOME_ID
  let nextId = 1
  const listeners = new Set<(list: TabSummary[]) => void>()
  /** Tabs mid close-prompt, so a second click cannot stack dialogs (as in TabManager). */
  const closing = new Set<string>()
  let closePrompt: ((request: ShellCloseRequest) => Promise<ShellCloseDecision>) | null = null

  const list = (): TabSummary[] =>
    tabs.map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      closable: tab.id !== HOME_ID,
      active: tab.id === activeId,
    }))

  const broadcast = (): void => {
    const snapshot = list()
    for (const listener of listeners) listener(snapshot)
  }

  const frameSrc = (tab: { id: string; kind: TabKind }): string | null => {
    if (!isWebFrameKind(tab.kind)) return null
    return `${WEB_APP_PATHS[tab.kind]}?${FRAME_ID_PARAM}=${encodeURIComponent(tab.id)}`
  }

  const activate = (id: string, navigate: 'push' | 'replace' | 'none'): void => {
    const target = tabs.find((tab) => tab.id === id)
    if (target === undefined) return
    activeId = id
    if (navigate === 'push') deps.route.push(routeFor(target))
    else if (navigate === 'replace') deps.route.replace(routeFor(target))
    broadcast()
  }

  const openTab = (kind: WebFrameKind): string => {
    const id = `t${nextId++}`
    tabs.push({ id, kind, title: deps.titleFor(kind) })
    activate(id, 'push')
    return id
  }

  /** Adopt a tab id that came from the URL, so Back to it lands on the same tab. */
  const adoptTab = (id: string, kind: TabKind): void => {
    if (!isWebFrameKind(kind)) return
    tabs.push({ id, kind, title: deps.titleFor(kind) })
    const numeric = /^t(\d+)$/.exec(id)
    if (numeric !== null) nextId = Math.max(nextId, Number(numeric[1]) + 1)
  }

  const remove = (id: string): void => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    tabs.splice(index, 1)
    deps.frames.register(id, null)
    if (activeId === id) {
      // Same fallback as the Electron tab manager: the tab to the left, or Home.
      const fallback = tabs[index - 1] ?? tabs[0]
      activate(fallback.id, 'replace')
    } else {
      broadcast()
    }
  }

  /** Close a tab, guarding unsaved work. */
  const closeTab = async (id: string): Promise<void> => {
    if (id === HOME_ID) return
    const tab = tabs.find((entry) => entry.id === id)
    if (tab === undefined || closing.has(id)) return
    if (frameSrc(tab) !== null) {
      closing.add(id)
      try {
        if (await deps.frames.wouldLoseWork(id)) {
          if (closePrompt === null) {
            console.warn(
              `[shell] tab ${id} reports unsaved work but no close prompt is installed; ` +
                `keeping the tab open rather than discarding it.`,
            )
            return
          }
          if (activeId !== id) activate(id, 'push')
          const summary = list().find((entry) => entry.id === id)
          if (summary === undefined) return
          const decision = await closePrompt({
            tab: summary,
            save: () => deps.frames.requestSave(id),
          })
          if (decision === 'keep') return
        }
      } finally {
        closing.delete(id)
      }
      // The list can have changed while the dialog was up.
      if (!tabs.some((entry) => entry.id === id)) return
    }
    remove(id)
  }

  /** Make the tab list match the URL. */
  const applyRoute = (): void => {
    const target = parseRoute(deps.route.hash())
    if (target === null) {
      activate(HOME_ID, 'none')
      return
    }
    if (!tabs.some((tab) => tab.id === target.id)) adoptTab(target.id, target.kind)
    activate(target.id, 'none')
  }

  const offRoute = deps.route.onChange(applyRoute)
  applyRoute()

  // Frame titles. Polled rather than pushed: `document.title` is a property of
  // the frame's document, readable because the frames are same-origin, so no app
  // has to cooperate and no message can be spoofed to rename a tab.
  const stopPoll = deps.schedule(() => {
    let changed = false
    for (const tab of tabs) {
      if (frameSrc(tab) === null) continue
      const title = deps.frames.titleOf(tab.id)
      if (title === null || title === tab.title) continue
      tab.title = title
      changed = true
    }
    if (changed) broadcast()
  }, TITLE_POLL_MS)

  return {
    openTab,
    dispose(): void {
      offRoute()
      stopPoll()
    },
    tabs: {
      list: async () => list(),
      activate: async (id) => activate(id, 'push'),
      close: (id) => closeTab(id),
      reorder: async (id, toIndex) => {
        if (id === HOME_ID) return
        const from = tabs.findIndex((tab) => tab.id === id)
        if (from < 0) return
        // Home stays pinned at index 0, exactly as in the Electron manager.
        const to = Math.min(Math.max(Math.trunc(toIndex), 1), tabs.length - 1)
        if (to === from) return
        const [moved] = tabs.splice(from, 1)
        tabs.splice(to, 0, moved)
        broadcast()
      },
      onChanged: (handler) => {
        listeners.add(handler)
        return () => void listeners.delete(handler)
      },
    },
    frames: {
      srcFor: (tab) => frameSrc(tab),
      register: (id, frame) => {
        if (frame === null || frame.contentWindow === null) {
          deps.frames.register(id, null)
          return
        }
        const element = frame
        deps.frames.register(id, {
          // Getters, not a snapshot: a frame navigates (its app routes, or is
          // reloaded), and a captured document would then be the previous one —
          // so the tab title would freeze at whatever it said before.
          get window() {
            return element.contentWindow as NonNullable<typeof element.contentWindow>
          },
          get document() {
            return element.contentDocument
          },
        })
      },
      setClosePrompt: (prompt) => {
        closePrompt = prompt
      },
    },
  }
}

/** The Home file lists, on a host that keeps none. */
export function createWebShellFilesPort(): ShellFilesPort {
  const emptyPage: FilePage = { entries: [], total: 0, totalAll: 0 }
  const unreachable = (member: string, ref: FileRef | FileRef[]): void => {
    console.warn(
      `[shell] files.${member} called with ${JSON.stringify(ref)}, but this host issues no ` +
        `file refs. Something is building a ref rather than using one the host gave it.`,
    )
  }
  return {
    recents: async () => emptyPage,
    starred: async () => emptyPage,
    statFiles: async (refs) => {
      unreachable('statFiles', refs)
      return []
    },
    toggleStar: async (ref) => unreachable('toggleStar', ref),
    removeRecent: async (refs) => unreachable('removeRecent', refs),
    rename: async (ref) => {
      unreachable('rename', ref)
      return { ok: false, error: 'This host keeps no file list to rename in.' }
    },
    duplicate: async (ref) => unreachable('duplicate', ref),
    deleteFiles: async (refs) => unreachable('deleteFiles', refs),
    // No file manager to reveal in, and no path to reveal.
    reveal: null,
  }
}

export interface WebShellPlatformDeps {
  language: ShellLanguagePort
  onboarding: ShellOnboardingPort
  app: ShellAppPort
  aiSettings: ShellAiSettingsPort
  tabs: ShellTabsPort
  frames: ShellFramesPort
  /** Opens a new tab of one of the kinds this host has a build for. */
  openTab: (kind: WebFrameKind) => void
}

/** New documents, and the one ref-taking member this host cannot resolve. */
export function createWebShellLauncherPort(
  openTab: (kind: WebFrameKind) => void,
): ShellLauncherPort {
  return {
    open: async (ref) => {
      console.warn(
        `[shell] launcher.open called with ${JSON.stringify(ref)}, but this host issues no ` +
          `file refs; documents are opened from inside an editor frame.`,
      )
    },
    newDoc: async () => openTab('docs'),
  }
}

/** The empty pdf surface — see `ShellPdfLauncherPort` for why this exists only here. */
export function createWebShellPdfLauncherPort(
  openTab: (kind: WebFrameKind) => void,
): ShellPdfLauncherPort {
  return { newPdfTab: async () => openTab('pdf') }
}

/** New spreadsheets, in a frame. */
export function createWebShellSheetsLauncherPort(
  openTab: (kind: WebFrameKind) => void,
): ShellSheetsLauncherPort {
  return { newSheet: async () => openTab('sheets') }
}

/** New presentations, in a frame. */
export function createWebShellSlidesLauncherPort(
  openTab: (kind: WebFrameKind) => void,
): ShellSlidesLauncherPort {
  return { newSlide: async () => openTab('slides') }
}

/** The AI provider configuration, read-only. */
export function createWebShellAiSettingsPort(
  fetchSettings: () => Promise<PublicAiSettings>,
): ShellAiSettingsPort {
  return {
    get: async (): Promise<AiSettingsSnapshot> => {
      const published = await fetchSettings()
      const providers: AiProviderConfigView[] = AI_PROVIDER_DEFINITIONS.map((definition) => {
        const entry = published.providers[definition.id]
        return {
          providerId: definition.id,
          model: entry?.model ?? definition.models[0] ?? definition.imageModels?.[0] ?? '',
          baseUrl: entry?.baseUrl ?? definition.defaultBaseUrl ?? '',
          credentialSet: entry?.credentialConfigured ?? false,
          // The BFF has no per-provider on/off switch: a provider is usable when the server holds a
          // credential for it, which `credentialSet` already says.
          enabled: true,
        }
      })
      return {
        activeProvider: published.active.providerId,
        activeModel: published.active.model,
        // The BFF chooses one provider for everything and publishes no separate image selection, so
        // naming one here would invent a setting the server does not have.
        imageProvider: '',
        imageModel: '',
        providers,
        definitions: AI_PROVIDER_DEFINITIONS.map((definition) => ({
          ...definition,
          models: [...definition.models],
          imageModels: [...(definition.imageModels ?? [])],
        })),
      }
    },
  }
}

/** UI language: the shared browser port, unchanged. */
export function createWebShellLanguagePort(language: LanguagePort): ShellLanguagePort {
  return language
}

export function createWebShellPlatform(deps: WebShellPlatformDeps): ShellPlatform {
  return {
    language: deps.language,
    app: deps.app,
    onboarding: deps.onboarding,
    files: createWebShellFilesPort(),
    launcher: createWebShellLauncherPort(deps.openTab),
    pdfLauncher: createWebShellPdfLauncherPort(deps.openTab),
    slidesLauncher: createWebShellSlidesLauncherPort(deps.openTab),
    sheetsLauncher: createWebShellSheetsLauncherPort(deps.openTab),
    frames: deps.frames,
    tabs: deps.tabs,
    aiSettings: deps.aiSettings,
    // The capabilities this host does not have.
    browse: null,
    projects: null,
    tabMenus: null,
    aiSettingsEditor: null,
  }
}
