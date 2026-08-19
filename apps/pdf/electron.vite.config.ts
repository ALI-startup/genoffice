import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { hostAlias, pdfjsCopyTargets } from './vite.shared'

export default defineConfig({
  // @samugen/i18n ships as TS source; pdf-lib's package only includes out/** — both must be bundled
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@samugen/i18n', 'pdf-lib', '@samugen/electron-utils', '@samugen/pdf-edit'],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@samugen/i18n'] })],
  },
  renderer: {
    // The Electron half of the host seam; the browser modules are never resolved here.
    resolve: { alias: hostAlias('electron') },
    plugins: [react(), viteStaticCopy({ targets: pdfjsCopyTargets() })],
    server: {
      port: Number(process.env.PDF_DEV_PORT) || 5176,
      strictPort: Boolean(process.env.PDF_DEV_PORT),
    },
  },
})
