/**
 * Opening an editor from the home screen.
 *
 * In a browser each editor is a same-origin iframe of the shell's own origin
 * (`/app/slides/`), which is the part that has no unit-test equivalent: the tab
 * strip, the frame's own bundle, and the language broadcast that has to cross the
 * frame boundary. A quick-create card needs no file picker — the document starts
 * unsaved — so this whole flow runs headless.
 */
import { test, expect } from '@playwright/test'
import { chooseLanguage, openShell } from './helpers'

test.describe('opening an editor', () => {
  test('a quick-create card opens an editor tab whose own UI loads', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })

    await page.locator('.quick-card', { hasText: 'AI Slides' }).click()

    // The tab strip gains the editor, and it is the active one.
    await expect(page.locator('.tab-item.active')).toContainText('SamuGen Slides')
    // The frame is served from this origin under the app's own path.
    const frame = page.frameLocator('iframe')
    await expect(frame.locator('.ribbon')).toBeVisible()
    await expect(frame.locator('.ribbon-tab', { hasText: 'Insert' })).toBeVisible()
    expect(page.frames().some((f) => f.url().includes('/app/slides/'))).toBe(true)
  })

  test('a language chosen on the home tab reaches inside the editor frame', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })
    await page.locator('.quick-card', { hasText: 'AI Slides' }).click()
    const frame = page.frameLocator('iframe')
    await expect(frame.locator('.ribbon-tab', { hasText: 'Home' })).toBeVisible()

    // The editor's ribbon has no language control of its own: the choice is made
    // once, on the home tab, and every open frame follows it. Which makes the
    // trip across the frame boundary the only thing holding this up.
    await page.locator('.tab-item.tab-home').click()
    await chooseLanguage(page, '한국어')
    await page.locator('.tab-item', { hasText: 'SamuGen Slides' }).click()

    // The editor is a separate document: it learns about the switch through storage,
    // not through a prop, and its whole ribbon has to follow.
    await expect(frame.locator('.ribbon-tab', { hasText: '홈' })).toBeVisible()
    await expect(frame.locator('.ribbon-tab', { hasText: '삽입' })).toBeVisible()
  })
})
