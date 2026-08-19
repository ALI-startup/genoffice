/**
 * The Electron half of sheets' host seam.
 *
 * The whole file is the two lines that read the preload globals. Everything else is in
 * platform-electron.ts, which takes the bridges as arguments and so stays testable without
 * a `window`.
 *
 * `main.tsx` reaches this module through the build-time `@host` alias, which each Vite
 * config points at exactly one host, so the Electron bundle carries no browser file code
 * and a web bundle no reference to `window.desktopApi`.
 */
import type { ProjectApi } from '@genoffice/project-store'
import { createElectronSheetsPlatform } from './platform-electron'
import type { CreateSheetsPlatform } from './platform'

export const createSheetsPlatform: CreateSheetsPlatform = async () =>
  createElectronSheetsPlatform(
    window.desktopApi,
    (window as Window & { projectApi?: ProjectApi }).projectApi ?? null,
  )
