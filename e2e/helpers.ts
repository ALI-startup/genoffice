/** Shared setup for the web E2E tests. */
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
 * Pick a UI language from the shell's only language control: the list behind the Language row of
 * the bottom-left Settings menu, on the home screen.
 */
export async function chooseLanguage(page: Page, label: string): Promise<void> {
  await page.locator('.account-btn').click()
  await page.locator('.lang-row').hover()
  await page.locator('.lang-flyout .lang-menu-item', { hasText: label }).click()
}

/** Load the shell at its root, with the storage state a test asks for. */
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
