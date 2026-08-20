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

/**
 * The language list in the bottom-left Settings menu.
 *
 * This one is a browser test and not a component one because every part of the
 * bug was the browser's: the flyout is `position: fixed`, and it is scroll
 * events, scroll chaining and pointer capture — not React state — that decide
 * whether it is still on screen when the reader arrives at the language they
 * were reaching for. A jsdom render has no scrolling to speak of.
 */
test.describe('the language list in the settings menu', () => {
  test('stays open while its list is scrolled, and switches to one at the end of it', async ({
    page,
  }) => {
    await openShell(page, { onboardingSeen: true })
    await expect(page.locator('.quick-card', { hasText: 'AI Docs' })).toBeVisible()

    await page.locator('.account-btn').click()
    await page.locator('.lang-row').hover()

    const flyout = page.locator('.lang-flyout')
    await expect(flyout).toBeVisible()

    // Nineteen languages in a box that holds a handful: reaching the end of this
    // list means scrolling it, which is what everything below is about.
    const overflow = await flyout.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(overflow).toBeGreaterThan(0)
    // It also has to be on screen in full. The page scroll cannot reach a fixed
    // element, so any part of it above the viewport is unreachable, not just
    // out of sight.
    const top = await flyout.evaluate((el) => el.getBoundingClientRect().top)
    expect(top).toBeGreaterThanOrEqual(0)

    // A wheel over the list scrolls the list. The flyout's own scroll event
    // reaches the shell's capture-phase listener too, which used to read it as
    // the page moving under the popup and close it on the first notch.
    await flyout.hover()
    await page.mouse.wheel(0, 240)
    await expect.poll(() => flyout.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await expect(flyout).toBeVisible()

    // Again at the bottom of the list, where a wheel with nowhere left to go
    // chains into the sidebar behind it and moves the row this is anchored to.
    await flyout.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.mouse.wheel(0, 240)
    await expect(flyout).toBeVisible()

    // And the last language is selectable, not merely visible: clicking it
    // scrolls it into view first, which is another scroll of the same list.
    const last = flyout.locator('.lang-menu-item').last()
    await expect(last).toHaveText('繁體中文')
    await last.click()

    await expect(page.locator('.nav-label', { hasText: '最近' }).first()).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), LANGUAGE_KEY))
      .toBe('zh-TW')
  })
})
