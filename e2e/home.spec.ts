/**
 * The home screen and the language switch, in a real browser.
 *
 * The language assertions are here rather than in a unit test because the thing that
 * can actually break is the boot path: the shell reads the stored language before its
 * first render, and the switch writes through to storage so every other open page and
 * frame follows. Neither half is visible to a component test.
 */
import { test, expect } from '@playwright/test'
import { LANGUAGE_KEY, openShell } from './helpers'

test.describe('home screen', () => {
  test('shows the hero, the quick-create cards and the tab strip', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })

    await expect(page.locator('.home-hero')).toBeVisible()
    // One card per editor that can be created from empty.
    for (const label of ['AI Docs', 'AI Sheets', 'AI Slides']) {
      await expect(page.locator('.quick-card', { hasText: label })).toBeVisible()
    }
    // The tab strip is the shell's own chrome, with home as the first tab.
    await expect(page.locator('.tab-item.tab-home')).toBeVisible()
    await expect(page.locator('.lang-toggle-tabbar')).toBeVisible()
  })

  test('the switch turns the chrome Korean and writes the choice through', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })
    await expect(page.locator('.quick-card', { hasText: 'AI Docs' })).toBeVisible()

    await page.locator('.lang-toggle-option', { hasText: '한국어' }).click()

    // The editors keep their product names in every language; the chrome around them
    // is what translates, so the sidebar is the honest assertion.
    await expect(page.locator('.nav-label', { hasText: '최근 사용' }).first()).toBeVisible()
    await expect(page.locator('.lang-toggle-option.active')).toHaveText('한국어')
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_KEY))
      .toBe('ko')
  })

  test('a stored language is honoured before the first render', async ({ page }) => {
    await openShell(page, { onboardingSeen: true, lang: 'ko' })

    // No toggling in this test: this is the boot path, which is what a returning
    // visitor gets and what would regress silently.
    await expect(page.locator('.nav-label', { hasText: '최근 사용' }).first()).toBeVisible()
    await expect(page.locator('.lang-toggle-option.active')).toHaveText('한국어')
  })
})
