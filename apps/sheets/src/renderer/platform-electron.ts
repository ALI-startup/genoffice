/**
 * Builds sheets' platform from the Electron preload bridge (`window.desktopApi`).
 *
 * Short, and it should be: the bridge already *is* most of the ports. `DesktopApi` was the
 * surface the renderer used directly, and every port in platform.ts except `attachments` is
 * a `Pick` of it, so one object satisfies them all structurally — no per-member forwarding,
 * no chance of a typo in thirty signatures. What the file adds is the *statement* that this
 * host backs every capability, including the five a browser cannot.
 *
 * `attachments` is the exception, and the only adapter here: the port is ref-based and the
 * bridge is path-based, so the shared Electron adapter maps between them (a ref *is* the
 * absolute path on this host). That is the same collapse docs and slides already went
 * through — sheets was the last copy (§6.3).
 *
 * Nothing here touches Electron or a global: the bridges are passed in, so the globals are
 * read exactly once, in host-electron.ts.
 */
import { createElectronAttachmentsPort } from '@genoffice/platform-electron'
import type { ProjectApi } from '@genoffice/project-store'
import type { DesktopApi } from '../shared/desktop-api'
import type { SheetsPlatform } from './platform'

export function createElectronSheetsPlatform(
  api: DesktopApi,
  project: ProjectApi | null,
): SheetsPlatform {
  return {
    workbook: api,
    file: api,
    window: api,
    language: api,
    ai: api,
    attachments: createElectronAttachmentsPort(api),
    project,
    // The four a browser has to answer `null` for. Electron backs every one, so the
    // renderer's capability checks always pass here and the desktop app is unchanged.
    menu: api,
    pdfExport: api,
    search: api,
  }
}
