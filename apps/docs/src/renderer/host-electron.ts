/**
 * The Electron half of docs' host seam.
 *
 * The whole file is the one line that reads the preload global. Everything else
 * is in platform-electron.ts, which takes the bridge as an argument and so stays
 * testable without a `window`.
 *
 * `main.tsx` reaches this module through the build-time `@host` alias, which each
 * Vite config points at exactly one host (see vite.shared.ts), so the Electron
 * bundle carries no File System Access code and the web bundle no reference to
 * `window.desktop`. `tsc` resolves `@host` here — see the `paths` entry in
 * tsconfig.json — and host-web.ts is checked in its own right because it
 * annotates its export as `CreateDocsPlatform`, the contract main.tsx consumes,
 * so the two hosts cannot drift.
 */
import { createElectronDocsPlatform } from './platform-electron'
import type { CreateDocsPlatform } from './platform'

export const createDocsPlatform: CreateDocsPlatform = async () =>
  createElectronDocsPlatform(window.desktop)
