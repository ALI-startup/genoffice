/**
 * Shared setup for the web E2E tests.
 *
 * The state these tests care about lives in the page's own storage rather than in a
 * user-data directory, so "a fresh install" and "a returning user" are one
 * `addInitScript` apart. Each test gets its own browser context from Playwright, so
 * nothing leaks between them and no scratch directory has to be cleaned up.
 */
import type { Page } from '@playwright/test'

/** Where the shell records that the first-run tour has been seen (see host-web.ts). */
export const ONBOARDING_KEY = 'samugen.shell.onboardingSeen'

/** Where the language switch stores its choice (see @samugen/platform-web). */
export const LANGUAGE_KEY = 'samugen.language'

export interface OpenOptions {
  /** Skip the first-run tour and land on the home screen. */
  onboardingSeen?: boolean
  /** Start in this UI language instead of the browser's. */
  lang?: string
}

/**
 * Load the shell at its root, with the storage state a test asks for.
 *
 * The seeding runs as an init script, not after navigation: the shell reads both
 * values while it boots (main.tsx awaits them before the first render), so writing
 * them afterwards would be a reload too late.
 */
export async function openShell(page: Page, options: OpenOptions = {}): Promise<void> {
  const { onboardingSeen = false, lang } = options
  if (onboardingSeen || lang) {
    await page.addInitScript(
      ([key, langKey, seen, language]) => {
        if (seen) localStorage.setItem(key as string, 'true')
        if (language) localStorage.setItem(langKey as string, language as string)
      },
      [ONBOARDING_KEY, LANGUAGE_KEY, onboardingSeen, lang ?? ''] as const,
    )
  }
  await page.goto('/')
}
