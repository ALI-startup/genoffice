import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostAlias } from './vite.shared'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Pin resolution to this repo's workspace sources (matches tsconfig paths)
  resolve: {
    alias: {
      // Subpath before the bare name: string aliases are prefix replacements Kept in step with
      // electron.vite.config.ts: a bare-name alias is a prefix replacement, so every declared
      // subpath needs its own entry or it resolves to a path under index.ts.
      '@samugen/pptx-engine/node': resolve(here, '../../packages/pptx-engine/src/save-node.ts'),
      '@samugen/pptx-engine/table-grid': resolve(
        here,
        '../../packages/pptx-engine/src/table-grid.ts',
      ),
      '@samugen/pptx-engine/background-promote': resolve(
        here,
        '../../packages/pptx-engine/src/background-promote.ts',
      ),
      '@samugen/pptx-engine': resolve(here, '../../packages/pptx-engine/src/index.ts'),
      '@samugen/pptx-render': resolve(here, '../../packages/pptx-render/src/index.ts'),
      // The same host tsconfig maps `@host` to; a test that wants a fake fills the
      // platform slot instead (tests/helpers/platform.ts).
      ...hostAlias(),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
