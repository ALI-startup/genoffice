import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@samugen/i18n'
import { createPdfPlatform } from '@host'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import { pdfPlatform, setPdfPlatform } from './platform'
import './styles.css'

// The single bootstrap, shared by both hosts.
void (async () => {
  // Install the host implementation before anything renders: every other module
  // reaches the host through the slot, and the slot throws until this runs.
  setPdfPlatform(await createPdfPlatform())

  const lang: Lang = await pdfPlatform()
    .language.getLanguage()
    .catch(() => 'zh' as const)
  document.documentElement.lang = htmlLang(lang)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
