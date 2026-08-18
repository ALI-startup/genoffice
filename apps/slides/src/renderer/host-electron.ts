/**
 * The Electron half of slides' host seam.
 *
 * The whole file is the three lines that read the preload globals. Everything else is in
 * platform-electron.ts, which takes the bridges as arguments and so stays testable
 * without a `window`.
 *
 * `main.tsx` reaches this module through the build-time `@host` alias, which each Vite
 * config points at exactly one host, so the Electron bundle carries no browser file code
 * and a web bundle no reference to `window.slidesApi`.
 */
import type { ProjectApi } from '@genoffice/project-store'
import { createElectronSlidesPlatform } from './platform-electron'
import type { CreateSlidesPlatform } from './platform'

export const createSlidesPlatform: CreateSlidesPlatform = async () =>
  createElectronSlidesPlatform(
    window.slidesApi,
    window.desktop,
    (window as Window & { projectApi?: ProjectApi }).projectApi ?? null,
  )
