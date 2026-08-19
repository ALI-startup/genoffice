import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@samugen/i18n'
import { App } from './App'
import { AudienceView } from './components/AudienceView'
// The build-time host seam: each Vite config aliases `@host` to exactly one of
// host-electron.ts / host-web.ts, so this entry point names no host at all and the two
// bundles carry disjoint host code.
import { createSlidesPlatform } from '@host'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import { setSlidesPlatform } from './platform'
import './styles.css'
import { slidesLanguage } from './platform'

// ?mode=audience: the presenter view's external-screen audience show window (created by the main process)
const mode = new URLSearchParams(window.location.search).get('mode')

// macOS windows are created with vibrancy; let the thumbnail pane show it
// (the audience show window stays fully opaque)
if (mode !== 'audience' && navigator.platform.toLowerCase().includes('mac'))
  document.body.classList.add('vib')

async function bootstrap(): Promise<void> {
  // Install the host before anything renders: every other renderer module reaches the
  // host through the slot, and the slot throws until this line has run.
  setSlidesPlatform(await createSlidesPlatform())
  let lang: Lang = 'zh'
  try {
    lang = await slidesLanguage().getLanguage()
  } catch {
    /* dev renderer without the preload handler */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        {mode === 'audience' ? <AudienceView /> : <App />}
      </LocaleProvider>
    </React.StrictMode>,
  )
}

void bootstrap()
