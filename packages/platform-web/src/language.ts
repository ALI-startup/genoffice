/** LanguagePort for a browser host. */
import { normalizeLang, type Lang } from '@samugen/i18n'
import type { LanguagePort } from '@samugen/platform'

export const LANGUAGE_STORAGE_KEY = 'samugen.language'

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
      // localStorage throws in some privacy configurations; the browser locale is always available,
      // so a storage failure degrades to it rather than failing the boot.
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

/** Persist a language choice, which also notifies the app's other tabs. */
export function setWebLanguage(env: LanguageHostEnv, lang: Lang): void {
  try {
    env.storage.setItem(LANGUAGE_STORAGE_KEY, lang)
  } catch {
    // no persistence and no cross-tab broadcast; the caller still applies it
  }
}
