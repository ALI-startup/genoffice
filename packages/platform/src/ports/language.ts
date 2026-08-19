/**
 * UI language capability.
 *
 * Present in every app renderer bridge: PdfApi, docs DesktopApi, SlidesApi and
 * sheets DesktopApi all expose the same getLanguage / onLanguageChanged /
 * setLanguage trio.
 *
 * Signature note: apps/pdf types this against `Lang` from @genoffice/i18n (19
 * languages), while docs, slides and sheets inline an older 11-language union
 * ('zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar').
 * `Lang` is the strict superset and the value the shell actually persists, so
 * the port standardises on it.
 *
 * `setLanguage` is required rather than nullable because both hosts genuinely
 * have it: Electron sends the choice to the process that owns app-settings.json
 * and it comes back to every window as `onLanguageChanged`; a browser writes it
 * to localStorage, whose `storage` event reaches every other document of the
 * origin. The one thing neither host does is notify the *caller* — a window
 * does not receive its own broadcast — so a caller applies the language locally
 * and treats the event as the way it learns about everyone else's switches.
 */
import type { Lang } from '@genoffice/i18n'

export interface LanguagePort {
  /** Current UI language (persisted by the shell in app-settings.json). */
  getLanguage(): Promise<Lang>
  /** Language switched elsewhere (another window, another tab); returns an unsubscribe. */
  onLanguageChanged(handler: (lang: Lang) => void): () => void
  /**
   * Switch the UI language for the whole app.
   *
   * Resolves once the host has taken the choice; every *other* window or frame
   * then sees it through `onLanguageChanged`.
   */
  setLanguage(lang: Lang): Promise<void>
}
