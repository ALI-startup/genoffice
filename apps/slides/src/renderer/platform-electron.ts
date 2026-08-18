/**
 * Builds slides' platform from the Electron preload bridges.
 *
 * Short, and it should be: the bridges already *are* the ports. `SlidesApi` was the
 * host surface the renderer used directly, and every port in platform.ts is a `Pick` of
 * it — so one object satisfies all of them structurally, with no per-member forwarding
 * and no chance of a typo in 148 signatures. What the file adds is the *statement* that
 * this host backs every capability, including the six that a browser cannot.
 *
 * Nothing here touches Electron or a global: the bridges are passed in, so the globals
 * are read exactly once, in host-electron.ts.
 */
import type { ProjectApi } from '@genoffice/project-store'
import type { DesktopFilesApi, SlidesApi } from '../shared/ipc'
import type { SlidesPlatform } from './platform'

export function createElectronSlidesPlatform(
  api: SlidesApi,
  files: DesktopFilesApi,
  project: ProjectApi | null,
): SlidesPlatform {
  return {
    doc: api,
    file: api,
    deckClipboard: api,
    window: api,
    language: api,
    ai: api,
    print: api,
    attachments: files,
    project,
    // The seven a browser has to answer `null` for. Electron backs every one, so the
    // renderer's capability checks always pass here and the desktop app is unchanged.
    presenter: api,
    pdfExport: api,
    clipboard: api,
    genspark: api,
    search: api,
    cloud: api,
    styleTemplates: api,
    menu: api,
  }
}
