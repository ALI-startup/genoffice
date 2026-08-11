import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { hostAlias, pdfjsCopyTargets } from './vite.shared'

// renderer-only dev server (embedded by shell via PDF_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  // Still an Electron host: the page runs inside a shell tab with the preload bridge.
  resolve: { alias: hostAlias('electron') },
  plugins: [react(), viteStaticCopy({ targets: pdfjsCopyTargets() })],
  server: {
    port: Number(process.env.PDF_DEV_PORT) || 5176,
    strictPort: true,
  },
})
