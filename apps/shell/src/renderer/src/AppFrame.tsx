import { useEffect, useState } from 'react'
import { FrameHost } from './FrameHost'
import { Home } from './Home'
import { Onboarding } from './Onboarding'
import { shellPlatform } from './platform'
import { TabBar } from './TabBar'
import { SettingsDialog } from './SettingsDialog'
import type { TabSummary } from '../../shared/tabs-api'

interface AppFrameProps {
  /** resolved before first paint (main.tsx) so home never flashes under the overlay */
  initialOnboardingSeen: boolean
}

export function AppFrame({ initialOnboardingSeen }: AppFrameProps) {
  const [homeActive, setHomeActive] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(!initialOnboardingSeen)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Non-null only on a host that hosts its editors in-page; Electron's are
  // WebContentsView children of this window and need nothing rendered here.
  const { frames } = shellPlatform()

  useEffect(() => {
    const { tabs } = shellPlatform()
    const applyTabs = (open: TabSummary[]) => {
      const active = open.find((tab) => tab.active)
      setHomeActive(!active || active.kind === 'home')
    }
    void tabs.list().then(applyTabs)
    return tabs.onChanged(applyTabs)
  }, [])

  const finishOnboarding = () => {
    setShowOnboarding(false)
    void shellPlatform()
      .onboarding.markSeen()
      .catch(() => {})
  }

  return (
    <div className="app-frame">
      <TabBar />
      {/* docs/sheets tabs render as WebContentsView children of this window, positioned
       * by the main process to cover this area — only Home paints its own content here. */}
      <div className="app-frame-content" style={{ visibility: homeActive ? 'visible' : 'hidden' }}>
        <Home onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      {/* On a browser host the editors are iframes rendered here, over Home.
       * They are kept mounted when backgrounded — see FrameHost. */}
      {frames && <FrameHost frames={frames} />}
      {/* editor WebContentsViews paint above ALL shell DOM, so the overlay only
       * renders while the home tab is active — it comes back when home does */}
      {showOnboarding && homeActive && <Onboarding onDone={finishOnboarding} />}
      {settingsOpen && homeActive && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
