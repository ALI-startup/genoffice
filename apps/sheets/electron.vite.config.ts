import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { hostAlias } from './vite.shared'

export default defineConfig({
  main: {
    // @samugen/* workspace packages ship TS source (no build step, no
    // compiled entry point) — externalizing them makes Node's ESM loader try
    // to resolve their relative imports at runtime and fail. Bundle those;
    // externalize everything else (Electron, zod, node builtins).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@samugen/ai-provider',
          '@samugen/agent-core',
          '@samugen/ai-search',
          '@samugen/file-parse',
          '@samugen/electron-utils',
          '@samugen/i18n',
        ],
      }),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at runtime.
    plugins: [],
  },
  renderer: {
    // The build-time host seam; see vite.shared.ts.
    resolve: { alias: hostAlias('electron') },
    plugins: [react()],
  },
})
