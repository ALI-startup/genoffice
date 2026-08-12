/**
 * The preload globals, declared once.
 *
 * These used to be declared inline in Home.tsx and TabBar.tsx, next to the code
 * that read them. They live here now because host-electron.ts is the only module
 * allowed to read them at all, and a declaration sitting inside a component
 * reads like an invitation to use it there.
 *
 * `aiOfficeProject` is optional because it genuinely may be missing: the Home
 * renderer is also loaded outside the shell, where the project preload was never
 * installed. Everything else is exposed by the preload that owns the document.
 */
import type { AiSettingsApi } from '../../shared/ai-settings-api'
import type { HomeApi, ProjectHomeApi } from '../../shared/home-api'
import type { TabsApi } from '../../shared/tabs-api'
import type { UpdateWindowApi } from '../../shared/update-api'

declare global {
  interface Window {
    /** src/preload/index.ts, in the shell window (index.html). */
    aiOffice: HomeApi
    aiOfficeTabs: TabsApi
    aiOfficeAiSettings: AiSettingsApi
    /** Absent when this renderer runs outside the shell. */
    aiOfficeProject?: ProjectHomeApi
    /** src/preload/update.ts, in the auto-update window (update.html). */
    aiOfficeUpdate: UpdateWindowApi
  }
}

export {}
