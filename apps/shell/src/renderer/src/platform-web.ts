/**
 * Builds the shell's platform for a browser.
 *
 * The mirror of platform-electron.ts, and it keeps the same discipline: nothing
 * here reads a browser global. The route, the frame link, the AI fetch and the
 * clocks are all injected, so every adapter — including the tab strip and the
 * close guard, which are the interesting ones — is exercisable without a DOM,
 * and host-web.ts stays the one file that touches `window`.
 *
 * What replaces what:
 *
 *   - Electron's tab strip is `TabManager` in the main process, hanging a
 *     `WebContentsView` per tab off one `BrowserWindow`. Here a tab is a route
 *     plus an iframe of the shell's own origin, and `createWebShellTabs` below
 *     is the same bookkeeping — open, activate, reorder, close, broadcast —
 *     minus everything native views brought with them (bounds, menus, fullscreen
 *     tracking, the docs teardown workaround for an Electron freeze).
 *   - Electron's close guard is a native message box raised by the main process,
 *     which then drives the editor's save over IPC. Here it is the frame
 *     protocol plus a React dialog the renderer installs; see `closeTab`.
 *
 * Two capabilities are absent rather than approximated, and each is a `null` port
 * the UI already tests for: `projects` and `browse`. `sheetsLauncher` and
 * `slidesLauncher` were both null until their apps gained browser builds, which is
 * why they are two ports and not one.
 * `tabMenus` is null too, but for the opposite reason — the constraint that made
 * those menus native is an Electron artefact, so the tab strip renders its own
 * DOM menus when the port is absent.
 *
 * `files` is the one port here that is present and answers nothing, which needs
 * saying plainly: this host keeps no cross-application file registry, so its
 * lists are empty and every other member takes a `FileRef` it never issued and
 * is therefore unreachable by construction. Those members warn rather than
 * returning silently, on the same principle as `reportCloseSaveResult` in
 * @samugen/platform-web — if the invariant is ever broken, the mismatch is
 * visible instead of swallowed. Recent documents are not lost, only relocated:
 * each editor keeps its own, in the IndexedDB handle store that survives a
 * reload, and shows it inside its own frame.
 */
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

/**
 * Where each editor is served, relative to the shell's own origin.
 *
 * Sub-paths of the shell rather than each app's own port, and that is load
 * bearing in two directions. The editors call `/v1/ai` root-relative and the BFF
 * sends no CORS headers on purpose, so a cross-origin frame would simply fail
 * every AI request; and the shell reads each frame's `document.title`, which
 * only a same-origin frame allows. One proxy rule per prefix covers both, in dev
 * (vite.web.config.ts) and in whatever fronts the static files in a deployment.
 */
export const WEB_APP_PATHS: Record<WebFrameKind, string> = {
  docs: '/app/docs/',
  pdf: '/app/pdf/',
  slides: '/app/slides/',
  sheets: '/app/sheets/',
}

/**
 * The tab kinds this host can actually show.
 *
 * A subset of `TabKind`, and the subset is the point: it is exactly the apps with a browser
 * build, which as of Phase 6c is all four. `home` is the only kind left out, because it is
 * this shell's own page rather than a frame — and because this is a type rather than a
 * runtime check, a kind added without a build is a compile error rather than a blank frame.
 */
export type WebFrameKind = 'docs' | 'pdf' | 'slides' | 'sheets'

/** Is this a tab kind this host can host a frame for? */
export function isWebFrameKind(kind: TabKind): kind is WebFrameKind {
  return kind === 'docs' || kind === 'pdf' || kind === 'slides' || kind === 'sheets'
}

/** How often the shell re-reads its frames' document titles. */
export const TITLE_POLL_MS = 400

/** The route → tab mapping, as it appears in the address bar. */
export const ROUTE_HOME = '#/'

/**
 * The history surface the router needs; injected so routing is testable.
 *
 * `push` for a user-initiated activation and `replace` for a correction the user
 * did not ask for (the tab that inherits focus after a close), so Back walks the
 * tabs the user actually visited.
 */
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

/**
 * Parse a route back into the tab it names.
 *
 * A reload cannot restore a document — the editors own their handles, and a
 * handle needs a fresh grant — so a route to a frame tab reopens an *empty* tab
 * of that kind. That is the honest reading of the URL: it names a surface, not a
 * document.
 */
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
 * The tab strip, the frames it hosts, and the routing that keeps the address bar
 * honest about which one is showing.
 *
 * Returned as both ports at once because they are one piece of state: `srcFor`
 * has to agree with the tab list about which tabs have frames, and `close` has
 * to reach the frame link before it removes the tab.
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

  /**
   * Close a tab, guarding unsaved work.
   *
   * The Electron flow, transposed: ask the editor whether closing would lose
   * work, and if so bring the tab into view — a prompt about a document you
   * cannot see is a prompt you cannot answer — and put the decision to the user.
   * "Save" goes back through the frame protocol into the editor's own save path,
   * because that is the only place a save can happen: the editor owns the file
   * handle, and a browser grants file-write permission to the window that asked
   * for it.
   *
   * Without an installed prompt the tab stays open. That is the safe direction
   * and it is unreachable in practice — AppFrame installs one before it renders
   * a frame — but "no way to ask" must never mean "discard".
   */
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

  /**
   * Make the tab list match the URL.
   *
   * The URL is the source of truth for which tab shows, so this runs once at
   * startup (a deep link, or a reload) and again on every Back/Forward. A route
   * naming a tab this session no longer has reopens an empty one of that kind
   * rather than silently landing on Home — see `parseRoute` on why it can only
   * ever be empty.
   */
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

/**
 * The Home file lists, on a host that keeps none.
 *
 * See the file header: the lists are empty and everything else takes a ref this
 * host never issues, so it is unreachable by construction and says so loudly if
 * it is ever reached.
 */
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

/**
 * New spreadsheets, in a frame. Non-null since 6c gave apps/sheets a browser build; `options`
 * is dropped for the same reason `slidesLauncher` drops it — this host has no projects.
 */
export function createWebShellSheetsLauncherPort(
  openTab: (kind: WebFrameKind) => void,
): ShellSheetsLauncherPort {
  return { newSheet: async () => openTab('sheets') }
}

/**
 * New presentations, in a frame.
 *
 * `options` is accepted and dropped: it carries the project a new document belongs to, and
 * projects are a main-process store this host does not have (`projects` is null here for the
 * same reason). Dropping it silently is right precisely because the UI that supplies it —
 * Home's project sidebar — does not exist on this host either.
 */
export function createWebShellSlidesLauncherPort(
  openTab: (kind: WebFrameKind) => void,
): ShellSlidesLauncherPort {
  return { newSlide: async () => openTab('slides') }
}

/**
 * The AI provider configuration, read-only.
 *
 * Built from `PublicAiSettings` rather than from `toAiSettings`, because that
 * mapping exists to satisfy `AiPort` and drops the field a settings screen needs
 * — `credentialConfigured`, which becomes `credentialSet` here. What the screen
 * shows is therefore exactly what the server is willing to say about itself:
 * which provider and model it will use, and which providers it holds a
 * credential for.
 *
 * `credentialHint` is deliberately never set. The desktop host renders a
 * `••••1234` suffix from its own credential store; this one has no credential to
 * take a suffix from, and the BFF will not send one — its no-leak test asserts
 * that no four-character run of any credential appears in any response body. An
 * invented mask would be a fiction in the one place a user goes to check what
 * the server is configured with.
 */
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
          // The BFF has no per-provider on/off switch: a provider is usable when
          // the server holds a credential for it, which `credentialSet` already
          // says. Reporting every provider as enabled keeps this field from
          // making a second, weaker claim about the same thing.
          enabled: true,
        }
      })
      return {
        activeProvider: published.active.providerId,
        activeModel: published.active.model,
        // The BFF chooses one provider for everything and publishes no separate
        // image selection, so naming one here would invent a setting the server
        // does not have. Empty means the Image tab marks nothing as active,
        // which is the truth about this host.
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

/**
 * UI language: the shared browser port, unchanged.
 *
 * It reads the stored choice (or the browser's own locale), and its write is
 * what reaches the frames — the value lands in localStorage and a storage event
 * carries it to every other same-origin document. Same effect as the shell
 * broadcasting to each WebContentsView over IPC, and the subscription is the
 * same event seen from the other side: an editor frame that switches the
 * language is heard here.
 */
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
    // The capabilities this host does not have. Each is `null` rather than a
    // stub, so the UI that offers them is absent instead of inert — see
    // ShellPlatform in platform.ts for the reason behind each one.
    browse: null,
    projects: null,
    tabMenus: null,
    aiSettingsEditor: null,
  }
}
