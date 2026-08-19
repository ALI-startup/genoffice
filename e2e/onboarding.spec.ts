/**
 * The first-run tour, end to end in a browser.
 *
 * What is worth testing here is not the three slides — a unit test can render those
 * — but that the tour gates the home screen on a fresh profile, that finishing or
 * skipping it records the fact in the page's own storage, and that a returning
 * visitor never sees it again. That last part is the whole point of the flag, and it
 * is the part only a real page load can prove.
 */
import { test, expect } from '@playwright/test'
import { ONBOARDING_KEY, openShell } from './helpers'

test.describe('first-run onboarding', () => {
  test('walks all slides, then lands on home and stays there on reload', async ({ page }) => {
    await openShell(page)
    const overlay = page.locator('.onb-overlay')
    const title = page.locator('.onb-slide.active .onb-title')

    await expect(overlay).toBeVisible()
    await expect(title).toHaveText('Welcome to SamuGen')

    await page.locator('.onb-next').click()
    await expect(title).toHaveText('This is just the beginning')

    await page.locator('.onb-next').click()
    await expect(title).toHaveText('Free for everyone')

    // The last slide's primary button finishes the tour.
    await page.locator('.onb-next').click()
    await expect(overlay).toBeHidden()
    await expect(page.locator('.home-hero')).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY))
      .toBe('true')

    // The flag is what a reload reads, so reloading is the real assertion.
    await page.reload()
    await expect(page.locator('.home-hero')).toBeVisible()
    await expect(overlay).toHaveCount(0)
  })

  test('skip dismisses it and records the same flag', async ({ page }) => {
    await openShell(page)
    await expect(page.locator('.onb-overlay')).toBeVisible()
    await page.locator('.onb-skip').click()
    await expect(page.locator('.onb-overlay')).toBeHidden()
    await expect(page.locator('.home-hero')).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY))
      .toBe('true')
  })
})
