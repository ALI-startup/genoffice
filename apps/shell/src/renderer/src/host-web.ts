/**
 * The browser half of the shell's host seam — the counterpart of the only file in the bundle that
 * reads a browser global.
 */
import {
  browserLanguageEnv,
  createShellFrameLink,
  createWebLanguagePort,
  fetchPublicAiSettings,
  type LanguageHostEnv,
} from '@samugen/platform-web'
import { createI18n } from '@samugen/i18n'
import type { TabKind } from '../../shared/tabs-api'
import type { CreateShellPlatform, ShellAppPort, ShellOnboardingPort } from './platform'
import {
  createWebShellAiSettingsPort,
  createWebShellLanguagePort,
  createWebShellPlatform,
  createWebShellTabs,
  type RouteEnv,
  type Scheduler,
} from './platform-web'
import { strings } from './strings'

/** Injected by Vite from the shell's package.json; see vite.web.config.ts. */
declare const __SHELL_VERSION__: string

/** Where the first-run tour's "seen" flag lives, in place of app-settings.json. */
const ONBOARDING_STORAGE_KEY = 'samugen.shell.onboardingSeen'

/** Routing over the History API. */
function browserRouteEnv(scope: Window = window): RouteEnv {
  return {
    hash: () => scope.location.hash,
    push: (hash) => {
      if (scope.location.hash === hash) return
      scope.history.pushState(null, '', hash)
    },
    replace: (hash) => scope.history.replaceState(null, '', hash),
    onChange: (handler) => {
      // `popstate` covers Back/Forward through pushState entries; `hashchange` covers a hash typed
      // or pasted into the address bar, which fires no popstate.
      scope.addEventListener('popstate', handler)
      scope.addEventListener('hashchange', handler)
      return () => {
        scope.removeEventListener('popstate', handler)
        scope.removeEventListener('hashchange', handler)
      }
    },
  }
}

const browserScheduler: Scheduler = (tick, ms) => {
  const handle = window.setInterval(tick, ms)
  return () => window.clearInterval(handle)
}

function createWebOnboardingPort(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): ShellOnboardingPort {
  return {
    // localStorage throws in some privacy configurations.
    seen: async () => {
      try {
        return storage.getItem(ONBOARDING_STORAGE_KEY) === 'true'
      } catch {
        return true
      }
    },
    markSeen: async () => {
      try {
        storage.setItem(ONBOARDING_STORAGE_KEY, 'true')
      } catch {
        /* nothing to persist to; the tour reappears next load */
      }
    },
  }
}

function createWebAppPort(): ShellAppPort {
  return {
    version: async () => __SHELL_VERSION__,
  }
}

export const createShellPlatform: CreateShellPlatform = async () => {
  const languageEnv: LanguageHostEnv = browserLanguageEnv()
  // @samugen/platform-web's shared language port — the same one every editor
  // frame uses, so the shell and its frames resolve the stored choice
  // identically, and a switch made in either is seen by the other.
  const language = createWebShellLanguagePort(createWebLanguagePort(languageEnv))

  // The tab strip's own copy has to be localised before React exists, because the first tab (Home)
  // is created here.
  const translate = createI18n(strings)
  const lang = await language.getLanguage()
  const titleFor = (kind: TabKind): string => {
    if (kind === 'pdf') return translate(lang, 'newPdf')
    if (kind === 'slides') return translate(lang, 'newSlide')
    if (kind === 'sheets') return translate(lang, 'newSheet')
    return translate(lang, 'newDoc')
  }

  const { tabs, frames, openTab } = createWebShellTabs({
    route: browserRouteEnv(),
    frames: createShellFrameLink(),
    titleFor,
    homeTitle: 'SamuGen',
    schedule: browserScheduler,
  })

  return createWebShellPlatform({
    language,
    onboarding: createWebOnboardingPort(languageEnv.storage),
    app: createWebAppPort(),
    aiSettings: createWebShellAiSettingsPort(() => fetchPublicAiSettings()),
    tabs,
    frames,
    openTab,
  })
}
