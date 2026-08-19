/**
 * The browser half of the shell's host seam — the counterpart of
 * host-electron.ts, and the only file in the web bundle that reads a global.
 *
 * `vite.web.config.ts` aliases `@host` here, so nothing in this file (nor
 * anything it imports) reaches the Electron bundle, and none of the preload
 * globals are referenced: there is no bridge to shim, which is the point of
 * deleting the old web-shim.js.
 *
 * Only `createShellPlatform` is exported. The update window (`update.html`, and
 * `createUpdateWindowPlatform` beside it) has no web counterpart and must not
 * grow one: there is no updater in a browser — the page *is* the current
 * version — so the document, its preload and its platform stay Electron-only,
 * and update.ts keeps importing the Electron host by path.
 *
 * The AI surface takes no configuration. It reads the BFF's settings route on
 * this origin, which the dev server proxies — see `vite.web.config.ts`. That
 * indirection is required, not cosmetic: the shell's CSP is `connect-src 'self'`,
 * so a cross-origin BFF URL would be blocked outright, and same-origin is also
 * what stops any credential from being needed here. It is read-only: the BFF
 * loads its credentials from the environment once at boot and exposes no write
 * route, so `aiSettingsEditor` is null and the settings screen renders as a
 * report rather than a form.
 */
import {
  browserLanguageEnv,
  createShellFrameLink,
  createWebLanguagePort,
  fetchPublicAiSettings,
  type LanguageHostEnv,
} from '@genoffice/platform-web'
import { createI18n } from '@genoffice/i18n'
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

/**
 * The GenTeam community page from the onboarding's second slide.
 *
 * The same stable short link the Electron main process opens, repeated here
 * rather than shared because the main process is not in this bundle. It 302s to
 * the tokened invite, which stays out of the repo.
 */
const GENTEAM_URL = 'https://www.genspark.ai/genoffice/join'

/** Where the first-run tour's "seen" flag lives, in place of app-settings.json. */
const ONBOARDING_STORAGE_KEY = 'genoffice.shell.onboardingSeen'

/**
 * Routing over the History API.
 *
 * Hash routes rather than paths, and deliberately: the editors are served under
 * `/app/docs` and `/app/pdf` of this same origin, so a path-based shell route
 * would have to be distinguished from them by whatever serves the files, and a
 * deep link would 404 without an SPA rewrite rule. A hash needs neither, and it
 * is never sent to the server.
 */
function browserRouteEnv(scope: Window = window): RouteEnv {
  return {
    hash: () => scope.location.hash,
    push: (hash) => {
      if (scope.location.hash === hash) return
      scope.history.pushState(null, '', hash)
    },
    replace: (hash) => scope.history.replaceState(null, '', hash),
    onChange: (handler) => {
      // `popstate` covers Back/Forward through pushState entries; `hashchange`
      // covers a hash typed or pasted into the address bar, which fires no
      // popstate. Both land on the same idempotent handler.
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
    // localStorage throws in some privacy configurations. Treating that as
    // "seen" skips the tour rather than showing it on every load, which is what
    // the Electron host does when the flag is unreadable.
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
    openGenTeam: async () => {
      // `noopener` because the opened page must not get a handle on this window:
      // it could otherwise post into the frame protocol, which validates its
      // sender but has no reason to be reachable from an external page at all.
      window.open(GENTEAM_URL, '_blank', 'noopener,noreferrer')
    },
  }
}

export const createShellPlatform: CreateShellPlatform = async () => {
  const languageEnv: LanguageHostEnv = browserLanguageEnv()
  // @genoffice/platform-web's shared language port — the same one every editor
  // frame uses, so the shell and its frames resolve the stored choice
  // identically, and a switch made in either is seen by the other.
  const language = createWebShellLanguagePort(createWebLanguagePort(languageEnv))

  // The tab strip's own copy has to be localised before React exists, because
  // the first tab (Home) is created here. Same dictionary the UI uses, resolved
  // once against the language we just read.
  const translate = createI18n(strings)
  const lang = await language.getLanguage()
  const titleFor = (kind: TabKind): string => {
    if (kind === 'pdf') return translate(lang, 'openPdf')
    if (kind === 'slides') return translate(lang, 'newSlide')
    if (kind === 'sheets') return translate(lang, 'newSheet')
    return translate(lang, 'newDoc')
  }

  const { tabs, frames, openTab } = createWebShellTabs({
    route: browserRouteEnv(),
    frames: createShellFrameLink(),
    titleFor,
    homeTitle: 'GenOffice',
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
