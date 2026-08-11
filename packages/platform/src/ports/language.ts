/**
 * UI language capability.
 *
 * Present in every app renderer bridge: PdfApi, docs DesktopApi, SlidesApi and
 * sheets DesktopApi all expose the same getLanguage / onLanguageChanged pair.
 *
 * Signature note: apps/pdf types this against `Lang` from @genoffice/i18n (19
 * languages), while docs, slides and sheets inline an older 11-language union
 * ('zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar').
 * `Lang` is the strict superset and the value the shell actually persists, so
 * the port standardises on it.
 */
import type { Lang } from '@genoffice/i18n'

export interface LanguagePort {
  /** Current UI language (persisted by the shell in app-settings.json). */
  getLanguage(): Promise<Lang>
  /** Language switched elsewhere (shell home page); returns an unsubscribe. */
  onLanguageChanged(handler: (lang: Lang) => void): () => void
}
