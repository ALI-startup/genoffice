import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The adapters are driven through injected fakes (handle store, pickers,
    // window, fetch), so no jsdom is needed to exercise them.
    environment: 'node',
  },
})
