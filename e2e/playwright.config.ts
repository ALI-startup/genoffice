import { defineConfig, devices } from '@playwright/test'
import { dirname } from 'node:path'

/**
 * E2E config for the SamuGen web suite.
 *
 * The product is a browser app, so the tests run in Chromium against the composed
 * bundle exactly as it is deployed: `npm run build:shell:web` first, then a static
 * server (serve.mjs) in front of `apps/shell/dist/web`, which is what
 * docker/nginx serves in production. Nothing else is running — there is no
 * application server to start, and these tests do not exercise the AI BFF.
 *
 * Run with: `npm run test:e2e` (after `npm run build:shell:web`).
 *
 * E2E_CHROMIUM_PATH overrides the browser binary, for an environment that has
 * Chromium somewhere other than Playwright's own cache.
 */
const port = Number(process.env.E2E_WEB_PORT) || 4180
const executablePath = process.env.E2E_CHROMIUM_PATH

export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    // A trace is worth more than a screenshot here: a failure in a frame-hosted
    // editor is usually about what loaded, not about what it looked like.
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: 'node serve.mjs',
    url: `http://127.0.0.1:${port}/`,
    cwd: dirname(__filename),
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
