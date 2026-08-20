/** UI language capability. */
import type { Lang } from '@samugen/i18n'

export interface LanguagePort {
  /** Current UI language (persisted by the shell in app-settings.json). */
  getLanguage(): Promise<Lang>
  /** Language switched elsewhere (another window, another tab); returns an unsubscribe. */
  onLanguageChanged(handler: (lang: Lang) => void): () => void
  /** Switch the UI language for the whole app. */
  setLanguage(lang: Lang): Promise<void>
}
