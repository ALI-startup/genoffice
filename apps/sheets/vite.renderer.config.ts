import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { hostAlias } from './vite.shared'

// renderer-only dev server (embedded by the shell via SHEETS_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: hostAlias('electron') },
  plugins: [react()],
  server: {
    port: Number(process.env.SHEETS_DEV_PORT) || 5174,
    strictPort: true,
  },
})
