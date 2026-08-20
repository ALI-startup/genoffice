/**
 * Opening Hangul documents in the docs editor, in a real browser.
 *
 * These are E2E and not unit tests because the chain has no shorter honest form.
 * A `.hwp` open crosses everything: the file picker's handle, an iframe boundary,
 * a same-origin `fetch` the page's `connect-src 'self'` would otherwise block, a
 * JVM in another process, and only then the codec that turns the result into
 * editable content. Any one of those can be wired wrong while every unit test
 * passes.
 *
 * The picker is faked, because Playwright cannot drive the browser's own file
 * dialog — but only the picker. The bytes are a real HWP 5.0 binary and the
 * converter behind `/v1/convert` is the real one, so what is asserted is a real
 * conversion arriving in a real editor.
 *
 * The `.hwp` case needs the conversion service, so it skips without
 * E2E_CONVERT_URL rather than passing on a mock. `.hwpx` needs nothing but the
 * page and always runs.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { openShell } from './helpers'

// `__dirname`, not `import.meta`: Playwright loads a spec as CommonJS, which the
// config file's own `dirname(__filename)` already relies on.
/** hwplib's own BlankFileMaker output, with one line of Korean and Latin text. */
const HWP_FIXTURE = join(__dirname, '../services/hwp-convert/tests/fixtures/blank.hwp')
const FIXTURE_TEXT = '한글 문서 테스트 Hello HWP'

const hasConverter = Boolean(process.env.E2E_CONVERT_URL)

/**
 * Make the next Open dialog hand back `name` with `bytes`, in every frame.
 *
 * An init script rather than a route interception: the store calls
 * `showOpenFilePicker` directly, and what it gets back has to behave like a real
 * handle — `getFile()`, the permission pair, and structured-cloneable so the
 * store can persist it. This is the smallest object that satisfies all three.
 */
async function stubOpenPicker(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.addInitScript(
    ([fileName, base64]) => {
      const decoded = atob(base64 as string)
      const data = new Uint8Array(decoded.length)
      for (let i = 0; i < decoded.length; i += 1) data[i] = decoded.charCodeAt(i)
      const handle = {
        kind: 'file',
        name: fileName as string,
        queryPermission: () => Promise.resolve('granted'),
        requestPermission: () => Promise.resolve('granted'),
        getFile: () =>
          Promise.resolve(
            new File([data], fileName as string, { lastModified: 1_700_000_000_000 }),
          ),
        createWritable: () => {
          const chunks: number[] = []
          return Promise.resolve({
            write: (data: BlobPart) =>
              (data instanceof Blob
                ? data.arrayBuffer()
                : Promise.resolve(data as ArrayBuffer)
              ).then((buffer) => {
                chunks.push(...new Uint8Array(buffer as ArrayBuffer))
              }),
            close: () => {
              const store = window as unknown as { __samugenWrites?: number[][] }
              store.__samugenWrites = [...(store.__samugenWrites ?? []), chunks]
              return Promise.resolve()
            },
          })
        },
      }
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: () => Promise.resolve([handle]),
      })
    },
    [name, Buffer.from(bytes).toString('base64')] as const,
  )
}

/** Open a docs tab from the home screen and wait for its ribbon. */
async function openDocsTab(page: Page) {
  await page.locator('.quick-card', { hasText: 'AI Docs' }).click()
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('.ribbon')).toBeVisible()
  return frame
}

/** File ▸ Open, inside the editor frame. */
async function chooseOpen(frame: ReturnType<Page['frameLocator']>): Promise<void> {
  await frame.locator('.ribbon-tab', { hasText: 'File' }).click()
  await frame.locator('.file-menu button', { hasText: 'Open' }).first().click()
}

test.describe('opening a .hwpx', () => {
  test('opens as a document bound to its file, with its text in the editor', async ({ page }) => {
    // Built here rather than committed: the codec that reads it in the page is the
    // same one that writes it, so the fixture cannot drift from the format under
    // test.
    const { htmlToHwpx } = await import('@samugen/hwpx-convert')
    const bytes = await htmlToHwpx('<h1>보고서 제목</h1><p>본문 문장입니다.</p>')
    await stubOpenPicker(page, 'report.hwpx', bytes)
    await openShell(page, { onboardingSeen: true })
    const frame = await openDocsTab(page)

    await chooseOpen(frame)

    // The document's own text, converted in the page and loaded into the editor.
    await expect(frame.locator('.editor-scroll .ProseMirror')).toContainText('보고서 제목')
    await expect(frame.locator('.editor-scroll .ProseMirror')).toContainText('본문 문장입니다.')
    // "Opened", not "Imported": a `.hwpx` is a document here, and the status line
    // is where that distinction is visible to the user.
    await expect(frame.locator('.status-msg')).toContainText('report.hwpx')
    await expect(frame.locator('.status-msg')).toContainText('Opened')
    // The shell's tab follows the frame's title, so the strip names the Hangul
    // file rather than the blank document the tab was created for.
    await expect(page.locator('.tab-item.active')).toContainText('report.hwpx')
  })

  test('saves back over the same file, as .hwpx, without a dialog', async ({ page }) => {
    // The whole difference from an import: Ctrl+S writes the file it came from.
    // The stub handle records what it was handed, so what is asserted is a real
    // write of a real package — not merely that the command reported success.
    const { htmlToHwpx } = await import('@samugen/hwpx-convert')
    await stubOpenPicker(page, 'report.hwpx', await htmlToHwpx('<p>처음 문장</p>'))
    await openShell(page, { onboardingSeen: true })
    const frame = await openDocsTab(page)
    await chooseOpen(frame)
    await expect(frame.locator('.editor-scroll .ProseMirror')).toContainText('처음 문장')

    // Type, then save with the keyboard — the path a user takes.
    await frame.locator('.editor-scroll .ProseMirror').click()
    await page.keyboard.type(' 추가')
    await page.keyboard.press('Control+s')

    await expect(frame.locator('.status-msg')).toContainText('Saved')

    // What reached the file, read back by the codec. A `.docx` would also start
    // with "PK", so the check is that this parses as an OWPML package *and*
    // carries the edit — which is the only assertion that could not pass if the
    // save had quietly written the other format.
    const written = await frame.locator('body').evaluate(() => {
      const record = (window as unknown as { __samugenWrites?: number[][] }).__samugenWrites
      return record?.at(-1) ?? null
    })
    expect(written, 'the save wrote nothing to the opened file').not.toBeNull()
    const { hwpxToText } = await import('@samugen/hwpx-convert')
    expect(await hwpxToText(new Uint8Array(written!))).toContain('처음 문장 추가')
  })
})

test.describe('opening a .hwp', () => {
  test.skip(!hasConverter, 'needs the conversion service; set E2E_CONVERT_URL')

  test('converts through the service and opens the result as .hwpx', async ({ page }) => {
    await stubOpenPicker(page, 'sample.hwp', new Uint8Array(await readFile(HWP_FIXTURE)))
    await openShell(page, { onboardingSeen: true })
    const frame = await openDocsTab(page)

    await chooseOpen(frame)

    // The text of a real HWP 5.0 binary, having crossed the converter and the
    // codec — this is the assertion the whole feature exists for.
    await expect(frame.locator('.editor-scroll .ProseMirror')).toContainText(FIXTURE_TEXT)
    // Named as what it became, and reported as a conversion rather than an open:
    // the original cannot be written back, so the first save has to ask.
    await expect(frame.locator('.status-msg')).toContainText('sample.hwp')
    await expect(frame.locator('.status-msg')).toContainText('.hwpx')
  })

  test('reports the fix when the service is not there', async ({ page }) => {
    // Same shape as a deployment without the converter: the request leaves the
    // page and nothing useful comes back.
    await page.route('**/v1/convert/**', (route) => route.abort())
    await stubOpenPicker(page, 'sample.hwp', new Uint8Array(await readFile(HWP_FIXTURE)))
    await openShell(page, { onboardingSeen: true })
    const frame = await openDocsTab(page)

    await chooseOpen(frame)

    await expect(frame.locator('.status-msg')).toContainText('.hwpx')
  })
})
