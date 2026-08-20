/** Opening an editor from the home screen. */
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

  test('the pdf card opens the pdf surface, with its own Open button inside', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })

    await page.locator('.quick-card', { hasText: 'AI PDF' }).click()

    // Unlike the other three this card creates no document, so what proves it worked is
    // pdf's own empty state — and specifically its Open button, which is the only place a
    // browser can raise a file picker for a pdf (see ShellPdfLauncherPort).
    const frame = page.frameLocator('iframe')
    await expect(frame.locator('.pdf-placeholder')).toBeVisible()
    await expect(frame.locator('.pdf-open-btn')).toBeVisible()
    expect(page.frames().some((f) => f.url().includes('/app/pdf/'))).toBe(true)
  })

  test('a language chosen on the home tab reaches inside the editor frame', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })
    await page.locator('.quick-card', { hasText: 'AI Slides' }).click()
    const frame = page.frameLocator('iframe')
    await expect(frame.locator('.ribbon-tab', { hasText: 'Home' })).toBeVisible()

    // The editor's ribbon has no language control of its own: the choice is made once, on the home
    // tab, and every open frame follows it.
    await page.locator('.tab-item.tab-home').click()
    await chooseLanguage(page, '한국어')
    await page.locator('.tab-item', { hasText: 'SamuGen Slides' }).click()

    // The editor is a separate document: it learns about the switch through storage,
    // not through a prop, and its whole ribbon has to follow.
    await expect(frame.locator('.ribbon-tab', { hasText: '홈' })).toBeVisible()
    await expect(frame.locator('.ribbon-tab', { hasText: '삽입' })).toBeVisible()
  })

  test('the new-tab button opens a menu that can be used, not one clipped by the strip', async ({
    page,
  }) => {
    await openShell(page, { onboardingSeen: true })
    await expect(page.locator('.home-hero')).toBeVisible()

    await page.locator('.tab-new-btn').click()
    const menu = page.locator('.tab-menu')
    await expect(menu).toBeVisible()

    // What the bug looked like: the menu was in the DOM, "visible", and at the right coordinates —
    // but `.tab-strip`'s overflow meant the part below the strip was not painted, so a click where
    // the item appears to be hit the page behind it.
    const item = menu.getByRole('menuitem', { name: 'AI Docs' })
    const box = await item.boundingBox()
    if (!box) throw new Error('the AI Docs item has no box')
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x as number, y as number)
        return el ? `${el.tagName}.${el.className}` : 'nothing'
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(hit, 'the point where the item is drawn must belong to the menu').toContain(
      'tab-menu-item',
    )

    await item.click()

    await expect(page.locator('.tab-item.active')).toContainText('.docx')
    await expect(page.frameLocator('iframe').locator('.ribbon')).toBeVisible()
    await expect(menu).toHaveCount(0)
  })

  test('that menu closes when the strip scrolls out from under it', async ({ page }) => {
    await openShell(page, { onboardingSeen: true })
    await expect(page.locator('.home-hero')).toBeVisible()

    await page.locator('.tab-new-btn').click()
    await expect(page.locator('.tab-menu')).toBeVisible()

    // The menu is anchored in viewport coordinates, so a strip that scrolls would leave it
    // pointing at nothing. It closes instead of hanging in the wrong place.
    await page.locator('.tab-strip').evaluate((strip) => {
      strip.scrollLeft = 40
      strip.dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    await expect(page.locator('.tab-menu')).toHaveCount(0)
  })
})
