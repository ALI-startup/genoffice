import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { hostAlias } from './vite.shared'

// renderer-only dev server (embedded by the shell via DOCS_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  // Still an Electron host: this server is embedded in a shell tab, so `@host`
  // resolves to the preload-bridge implementation. See vite.shared.ts.
  resolve: { alias: hostAlias('electron') },
  plugins: [react()],
  server: {
    port: Number(process.env.DOCS_DEV_PORT) || 5173,
    strictPort: true,
  },
})
