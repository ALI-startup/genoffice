/**
 * The Electron half of the shell's host seam.
 *
 * The whole file is the handful of lines that read the preload globals.
 * Everything else is in platform-electron.ts, which takes the bridges as
 * arguments and so stays testable without a `window`.
 *
 * Two factories because the shell ships two documents with two preloads:
 * `main.tsx` (index.html) bootstraps from `createShellPlatform`, and `update.ts`
 * (update.html) from `createUpdateWindowPlatform`. Each reads only the globals
 * its own preload exposes — `window.aiOfficeUpdate` does not exist in the shell
 * window, and none of the others exist in the update window.
 *
 * `window.aiOfficeProject` is the one global that may legitimately be absent:
 * the Home renderer is also loaded outside the shell, where the project preload
 * was never installed. That is why it is typed optional in env.d.ts and turns
 * into a `null` port rather than a missing method.
 *
 * Both entry points import this module by path rather than through a `@host`
 * build-time alias, because there is only one host to point an alias at today.
 * Phase 5b adds the alias alongside the web host; see `CreateShellPlatform` in
 * platform.ts.
 */
import {
  createElectronShellPlatform,
  createElectronUpdateWindowPlatform,
} from './platform-electron'
import type { CreateShellPlatform, CreateUpdateWindowPlatform } from './platform'

export const createShellPlatform: CreateShellPlatform = async () =>
  createElectronShellPlatform({
    home: window.aiOffice,
    tabs: window.aiOfficeTabs,
    aiSettings: window.aiOfficeAiSettings,
    project: window.aiOfficeProject,
  })

export const createUpdateWindowPlatform: CreateUpdateWindowPlatform = async () =>
  createElectronUpdateWindowPlatform(window.aiOfficeUpdate)
