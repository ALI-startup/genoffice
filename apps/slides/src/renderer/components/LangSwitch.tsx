import { LanguageToggle } from '@samugen/ui'
import { useI18n } from '../i18n/locale'

/**
 * The app's English ⇄ Korean switch, bound to this renderer's locale context.
 *
 * A component rather than a call site per surface: the toggle appears wherever
 * the app has chrome, and every one of those places needs the same three
 * things wired the same way.
 */
export function LangSwitch({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n()
  return (
    <LanguageToggle
      lang={lang}
      onChange={setLang}
      label={t('appLanguage')}
      {...(className ? { className } : {})}
    />
  )
}
