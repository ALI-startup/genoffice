import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { hostAlias } from './vite.shared'

export default defineConfig({
  // Main and preload use only electron + node builtins; bundle everything so
  // the packaged app doesn't rely on node_modules at runtime.
  // @samugen/* deps ship as raw TS source with extensionless imports, so they
  // must be bundled — externalizing them yields ERR_MODULE_NOT_FOUND under Node
  // (same setup as apps/slides).
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@samugen/electron-utils'] })],
  },
  preload: {},
  renderer: {
    // The build-time host seam: this bundle gets the preload-bridge host and
    // never the browser one. See vite.shared.ts.
    resolve: { alias: hostAlias('electron') },
    plugins: [react()],
    server: {
      // Overridable so multiple samugen dev instances can coexist (default 5173).
      port: Number(process.env.DOCS_DEV_PORT) || 5173,
      strictPort: Boolean(process.env.DOCS_DEV_PORT),
    },
  },
})
