import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@samugen/i18n'
import { AppFrame } from './AppFrame'
// The build-time host seam: `@host` is aliased to host-electron.ts or
// host-web.ts by whichever Vite config is building, so the two hosts' code
// never meets in one bundle. tsconfig maps it to the Electron host so `tsc` has
// something to check this file against; host-web.ts is checked in its own right
// because it annotates its export as `CreateShellPlatform`.
import { createShellPlatform } from '@host'
import { LocaleProvider } from './locale'
import { setShellPlatform } from './platform'
import './home.css'
import './tabbar.css'

// macOS shell window is created with vibrancy; a transparent body lets the
// editor views' translucent regions (e.g. slides thumbnail pane) show it
if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('vib')

void (async () => {
  // Install the host implementation before anything renders: every other module
  // reaches the host through the slot, and the slot throws until this runs.
  const platform = await createShellPlatform()
  setShellPlatform(platform)

  // resolve the persisted language and the first-run flag before first paint so
  // the UI never flashes (home showing briefly before the onboarding overlay)
  const [lang, onboardingSeen] = await Promise.all([
    platform.language.getLanguage(),
    // if the flag is unreadable, skip onboarding rather than block the home screen
    platform.onboarding.seen().catch(() => true),
  ])
  document.documentElement.lang = htmlLang(lang)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        <AppFrame initialOnboardingSeen={onboardingSeen} />
      </LocaleProvider>
    </React.StrictMode>,
  )
})()
