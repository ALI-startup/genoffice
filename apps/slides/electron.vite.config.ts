import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { hostAlias } from './vite.shared'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const here = dirname(fileURLToPath(import.meta.url))

// Pin resolution to this repo's workspace sources (matches tsconfig paths;
// avoids bundling stale implementations when node_modules links point elsewhere)
const workspaceAlias = {
  // Subpath before the bare name: string aliases are prefix replacements, so a bare
  // '@samugen/pptx-engine' entry listed first would rewrite every subpath import
  // into a path *under* index.ts. Every subpath the exports map declares needs an
  // entry here, or the build fails with "ENOTDIR: not a directory .../index.ts/<sub>"
  // — which is how the `/node` entry below came to be added.
  '@samugen/pptx-engine/node': resolve(here, '../../packages/pptx-engine/src/save-node.ts'),
  '@samugen/pptx-engine/table-grid': resolve(here, '../../packages/pptx-engine/src/table-grid.ts'),
  '@samugen/pptx-engine/background-promote': resolve(
    here,
    '../../packages/pptx-engine/src/background-promote.ts',
  ),
  '@samugen/pptx-engine': resolve(here, '../../packages/pptx-engine/src/index.ts'),
  '@samugen/pptx-render': resolve(here, '../../packages/pptx-render/src/index.ts'),
  // The build-time host seam; see vite.shared.ts.
  ...hostAlias('electron'),
}

export default defineConfig({
  // Main process/preload must bundle @samugen/* sources (they are pulled in as TS
  // source with extensionless relative imports; externalizing them under Node
  // yields ERR_MODULE_NOT_FOUND).
  main: {
    resolve: { alias: workspaceAlias },
    // Bundle opentype.js too (the packaged app ships only out/**, so external deps are unresolvable at runtime)
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@samugen/pptx-engine',
          '@samugen/pptx-render',
          '@samugen/ai-search',
          '@samugen/file-parse',
          '@samugen/electron-utils',
          'opentype.js',
        ],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: { alias: workspaceAlias },
    plugins: [react()],
    server: {
      port: Number(process.env.SLIDES_DEV_PORT) || 5175,
      strictPort: Boolean(process.env.SLIDES_DEV_PORT),
    },
  },
})
