/**
 * Builds slides' platform from the Electron preload bridges.
 *
 * Short, and it should be: the bridges already *are* the ports. `SlidesApi` was the
 * host surface the renderer used directly, and every port in platform.ts is a `Pick` of
 * it — so one object satisfies all of them structurally, with no per-member forwarding
 * and no chance of a typo in 148 signatures — with one exception, `attachments`, which is
 * the shared ref-based port and gets the shared Electron adapter. What the file adds is the
 * *statement* that this host backs every capability, including the ones a browser cannot.
 *
 * Nothing here touches Electron or a global: the bridges are passed in, so the globals
 * are read exactly once, in host-electron.ts.
 */
import { createElectronAttachmentsPort } from '@samugen/platform-electron'
import type { ProjectApi } from '@samugen/project-store'
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
    // The one port the bridge does not already satisfy: `attachments` is ref-based and
    // `window.desktop` is path-based, so the shared Electron adapter maps between them
    // (a ref *is* the absolute path on this host).
    attachments: createElectronAttachmentsPort(files),
    project,
    // The nine a browser has to answer `null` for. Electron backs every one, so the
    // renderer's capability checks always pass here and the desktop app is unchanged.
    aiMedia: api,
    presenter: api,
    pdfExport: api,
    clipboard: api,
    search: api,
    styleTemplates: api,
    menu: api,
  }
}
