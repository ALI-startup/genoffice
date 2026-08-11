import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@genoffice/i18n'
import { App } from './App'
// The build-time host seam: each Vite config aliases `@host` to exactly one of
// host-electron.ts / host-web.ts, so this entry point names no host at all and
// the two bundles carry disjoint host code. See vite.shared.ts.
import { createDocsPlatform } from '@host'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import { setDocsPlatform } from './platform'
import './styles.css'
import './fonts/fonts.css'

async function bootstrap(): Promise<void> {
  // Install the host before anything renders: every other renderer module reaches
  // the host through the slot, and the slot throws until this line has run.
  const platform = await createDocsPlatform()
  setDocsPlatform(platform)
  let lang: Lang = 'zh'
  try {
    lang = await platform.language.getLanguage()
  } catch {
    /* dev renderer without the preload handler */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
}

void bootstrap()
