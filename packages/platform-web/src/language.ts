/**
 * LanguagePort for a browser host.
 *
 * Electron's language comes from the shell, which persists it in
 * app-settings.json and pushes changes over IPC. A browser has no shell, so the
 * three members map onto what a browser genuinely has:
 *
 *   - `getLanguage` — the stored choice if there is one, else the browser's own
 *     `navigator.language`, normalised through @genoffice/i18n so the same
 *     19-language `Lang` union comes out.
 *   - `setLanguage` — a write to the same storage key. That write *is* the
 *     broadcast: it is what the other documents observe.
 *   - `onLanguageChanged` — the `storage` event. This is a real event with real
 *     emissions: changing the language in one tab reaches every other tab of
 *     the same origin, which is the browser's equivalent of the shell pushing
 *     the change to every open editor.
 *
 * The one thing the `storage` event does not do is fire in the document that
 * wrote the value, and the same is true of Electron's broadcast for the window
 * that asked. Rather than paper over that with a synthetic self-notification —
 * which would make a caller's own `setLanguage` arrive twice on hosts that do
 * echo — the port leaves it as the contract in @genoffice/platform states: the
 * caller applies the language itself and subscribes for everyone else's.
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
    async setLanguage(lang: Lang) {
      setWebLanguage(env, lang)
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

/**
 * Persist a language choice, which also notifies the app's other tabs.
 *
 * Storage is best-effort for the same reason `getLanguage` treats it as such:
 * a browser configured to refuse it should still switch the language for the
 * session rather than throw out of a click handler.
 */
export function setWebLanguage(env: LanguageHostEnv, lang: Lang): void {
  try {
    env.storage.setItem(LANGUAGE_STORAGE_KEY, lang)
  } catch {
    // no persistence and no cross-tab broadcast; the caller still applies it
  }
}
