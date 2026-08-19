import ReactDOM from 'react-dom/client'
import { htmlLang, type Lang } from '@samugen/i18n'

import '@univerjs/preset-sheets-core/lib/index.css'

import { App } from './App'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import './styles.css'
// The build-time host seam: each Vite config aliases `@host` to exactly one of
// host-electron.ts / host-web.ts, so this entry point names no host at all and the two
// bundles carry disjoint host code.
import { createSheetsPlatform } from '@host'
import { setSheetsPlatform, sheetsLanguage } from './platform'

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', ({ updates }) => {
    const replacesUniverRuntime = updates.some(
      ({ path }) => path.endsWith('/App.tsx') || path.endsWith('/univer-sync.ts'),
    )
    if (replacesUniverRuntime) window.location.reload()
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root.')

async function bootstrap(): Promise<void> {
  // Install the host before anything renders: every other renderer module reaches the host
  // through the slot, and the slot throws until this line has run.
  setSheetsPlatform(await createSheetsPlatform())
  let lang: Lang = 'zh'
  try {
    lang = await sheetsLanguage().getLanguage()
  } catch {
    /* dev renderer without the preload handler */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  ReactDOM.createRoot(root!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
}

void bootstrap()
