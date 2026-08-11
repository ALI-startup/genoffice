/**
 * LanguagePort for a browser host.
 *
 * Electron's language comes from the shell, which persists it in
 * app-settings.json and pushes changes over IPC. A browser has no shell, so the
 * two members map onto what a browser genuinely has:
 *
 *   - `getLanguage` — the stored choice if there is one, else the browser's own
 *     `navigator.language`, normalised through @genoffice/i18n so the same
 *     19-language `Lang` union comes out.
 *   - `onLanguageChanged` — the `storage` event. This is a real event with real
 *     emissions: changing the language in one tab reaches every other tab of
 *     the same origin, which is the browser's equivalent of the shell pushing
 *     the change to every open editor.
 */
import { normalizeLang, type Lang } from '@genoffice/i18n'
import type { LanguagePort } from '@genoffice/platform'

export const LANGUAGE_STORAGE_KEY = 'genoffice.language'

/** The bits of `Storage` and `window` this port needs; injected so it is testable. */
export interface LanguageHostEnv {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  addEventListener: (type: 'storage', handler: (event: StorageEvent) => void) => void
  removeEventListener: (type: 'storage', handler: (event: StorageEvent) => void) => void
  /** Browser UI locale, e.g. `navigator.language`. */
  locale: string
}

export function browserLanguageEnv(scope: Window = window): LanguageHostEnv {
  return {
    storage: scope.localStorage,
    addEventListener: (type, handler) => scope.addEventListener(type, handler),
    removeEventListener: (type, handler) => scope.removeEventListener(type, handler),
    locale: scope.navigator.language,
  }
}

export function createWebLanguagePort(env: LanguageHostEnv): LanguagePort {
  return {
    async getLanguage() {
      // localStorage throws in some privacy configurations; the browser locale
      // is always available, so a storage failure degrades to it rather than
      // failing the boot.
      let stored: string | null
      try {
        stored = env.storage.getItem(LANGUAGE_STORAGE_KEY)
      } catch {
        stored = null
      }
      return normalizeLang(stored ?? env.locale)
    },
    onLanguageChanged(handler: (lang: Lang) => void) {
      const listener = (event: StorageEvent) => {
        if (event.key !== LANGUAGE_STORAGE_KEY) return
        handler(normalizeLang(event.newValue ?? env.locale))
      }
      env.addEventListener('storage', listener)
      return () => env.removeEventListener('storage', listener)
    },
  }
}

/** Persist a language choice, which also notifies the app's other tabs. */
export function setWebLanguage(env: LanguageHostEnv, lang: Lang): void {
  env.storage.setItem(LANGUAGE_STORAGE_KEY, lang)
}
