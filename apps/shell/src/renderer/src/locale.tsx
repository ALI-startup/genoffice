import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createI18n, htmlLang, type Lang, type Params } from '@genoffice/i18n'
import { shellPlatform } from './platform'
import { strings } from './strings'

const translate = createI18n(strings)

export type StringKey = keyof typeof strings.zh
export type TFunc = (key: StringKey, params?: Params) => string

interface LocaleValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const LocaleContext = createContext<LocaleValue>({ lang: 'zh', setLang: () => {} })

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  // One place applies a language, whether it came from the shell's own switcher
  // or from an editor's. The subscription is the half that is new: the shell
  // used to be the only place the language could be changed, and every app's
  // chrome now carries the same toggle.
  const apply = useCallback((next: Lang) => {
    document.documentElement.lang = htmlLang(next)
    setLangState(next)
  }, [])
  useEffect(() => shellPlatform().language.onLanguageChanged(apply), [apply])
  const value = useMemo<LocaleValue>(
    () => ({
      lang,
      setLang: (next) => {
        if (next === lang) return
        // Applied here rather than awaited back: no host echoes a switch to the
        // window that asked for it (see LanguagePort).
        apply(next)
        void shellPlatform().language.setLanguage(next)
      },
    }),
    [lang, apply],
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: TFunc
  /** BCP-47 locale for date/number formatting */
  dateLocale: string
}

/** BCP-47 locale per UI language, for date/number formatting */
const DATE_LOCALES: Record<Lang, string> = {
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  th: 'th-TH',
  id: 'id-ID',
  ru: 'ru-RU',
  ar: 'ar-SA',
  pt: 'pt-BR',
  it: 'it-IT',
  pl: 'pl-PL',
  nl: 'nl-NL',
  ms: 'ms-MY',
  he: 'he-IL',
  hi: 'hi-IN',
  'zh-TW': 'zh-TW',
}

export function useI18n(): I18n {
  const { lang, setLang } = useContext(LocaleContext)
  return {
    lang,
    setLang,
    t: (key, params) => translate(lang, key, params),
    dateLocale: DATE_LOCALES[lang],
  }
}
