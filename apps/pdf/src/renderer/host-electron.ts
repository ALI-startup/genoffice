/**
 * The Electron half of the build-time host seam.
 *
 * `main.tsx` imports `createPdfPlatform` from `@host`; `electron.vite.config.ts`
 * and `vite.renderer.config.ts` alias that specifier to this file, and
 * `vite.web.config.ts` aliases it to `host-web.ts`. Nothing chooses at runtime,
 * so the web bundle contains no Electron code and this bundle contains no
 * File System Access code.
 *
 * The whole file is the one line that reads the preload global. Everything else
 * is in platform-electron.ts, which takes the bridge as an argument and so stays
 * testable without a `window`.
 */
import { createElectronPdfPlatform } from './platform-electron'
import type { CreatePdfPlatform } from './platform'

export const createPdfPlatform: CreatePdfPlatform = async () =>
  createElectronPdfPlatform(window.pdfApi)
