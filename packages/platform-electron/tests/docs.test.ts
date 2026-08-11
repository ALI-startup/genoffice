import { describe, expect, it } from 'vitest'
import type { AttachmentReadResult } from '@genoffice/platform'
import {
  createDocsAttachmentsPort,
  createDocsCloseSavePort,
  createDocsLanguagePort,
  createDocsTabsPort,
} from '../src/index'

/**
 * Hand-written stand-in for docs' preload bridge, recording every call. As with
 * pdf.test.ts the point is that this shape is what apps/docs' `DesktopApi`
 * actually exposes — including the path-based attachment methods the port no
 * longer speaks, which is exactly what the adapter is for.
 */
function createFakeBridge(pathForFile = '/tmp/dropped.md') {
  const calls: { method: string; args: unknown[] }[] = []
  const listeners: Record<string, ((...args: never[]) => void)[]> = {
    language: [],
    closeSave: [],
  }
  const subscribe =
    (key: keyof typeof listeners) =>
    (handler: (...args: never[]) => void): (() => void) => {
      listeners[key]!.push(handler)
      return () => {
        const list = listeners[key]!
        list.splice(list.indexOf(handler), 1)
      }
    }
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }

  const accepted = {
    path: '/docs/notes.md',
    name: 'notes.md',
    ext: 'md',
    sizeBytes: 2048,
  }

  return {
    calls,
    listeners,
    accepted,
    bridge: {
      getLanguage: async () => 'ko' as const,
      onLanguageChanged: subscribe('language'),
      pickAttachments: async () => {
        record('pickAttachments')()
        return { accepted: [accepted], rejected: [] }
      },
      addAttachmentPaths: async (paths: string[]) => {
        record('addAttachmentPaths')(paths)
        return { accepted: [accepted], rejected: ['too-big.bin'] }
      },
      addPastedImage: async (data: ArrayBuffer, ext: string) => {
        record('addPastedImage')(data.byteLength, ext)
        return { accepted: [accepted], rejected: [] }
      },
      readAttachment: async (
        path: string,
        offset: number,
        maxChars: number,
      ): Promise<AttachmentReadResult> => {
        record('readAttachment')(path, offset, maxChars)
        return { ok: true, text: 'hi' }
      },
      readAttachmentImage: async (path: string) => {
        record('readAttachmentImage')(path)
        return { ok: true, base64: 'AAAA', mime: 'image/png' }
      },
      getPathForFile: () => pathForFile,
      openNewTab: async (openPath?: string | null) => {
        record('openNewTab')(openPath)
      },
      listDocsTabs: async () => {
        record('listDocsTabs')()
        return [{ id: 't1', title: 'notes.docx', focused: true }]
      },
      focusDocsTab: async (id: string) => {
        record('focusDocsTab')(id)
      },
      onCloseSaveRequest: subscribe('closeSave'),
      reportCloseSaveResult: record('reportCloseSaveResult'),
    },
  }
}

describe('createDocsLanguagePort', () => {
  it('forwards getLanguage and delivers changes until unsubscribed', async () => {
    const { bridge, listeners } = createFakeBridge()
    const port = createDocsLanguagePort(bridge)
    expect(await port.getLanguage()).toBe('ko')

    const seen: string[] = []
    const off = port.onLanguageChanged((lang) => seen.push(lang))
    listeners.language.forEach((fn) => (fn as (lang: string) => void)('ja'))
    expect(seen).toEqual(['ja'])

    off()
    expect(listeners.language).toHaveLength(0)
  })
})

describe('createDocsAttachmentsPort', () => {
  it('maps bridge metadata onto refs, keeping the path as the display location', async () => {
    const { bridge, accepted } = createFakeBridge()
    const result = await createDocsAttachmentsPort(bridge).pickAttachments()
    expect(result).toEqual({
      accepted: [
        {
          ref: accepted.path,
          name: 'notes.md',
          ext: 'md',
          sizeBytes: 2048,
          location: accepted.path,
        },
      ],
      rejected: [],
    })
  })

  it('passes refs straight through as paths and keeps rejections', async () => {
    const { bridge, calls } = createFakeBridge()
    const port = createDocsAttachmentsPort(bridge)

    const added = await port.addAttachments(['/a.md', '/b.md'])
    expect(added.rejected).toEqual(['too-big.bin'])
    expect(await port.readAttachment('/a.md', 10, 24_000)).toEqual({ ok: true, text: 'hi' })
    await port.readAttachmentImage('/img.png')
    await port.addPastedImage(new ArrayBuffer(4), 'png')

    expect(calls).toEqual([
      { method: 'addAttachmentPaths', args: [['/a.md', '/b.md']] },
      { method: 'readAttachment', args: ['/a.md', 10, 24_000] },
      { method: 'readAttachmentImage', args: ['/img.png'] },
      { method: 'addPastedImage', args: [4, 'png'] },
    ])
  })

  it('turns an unaddressable File into an explicit null instead of an empty path', async () => {
    const file = new File([], 'clip.png')
    expect(await createDocsAttachmentsPort(createFakeBridge().bridge).refForFile(file)).toBe(
      '/tmp/dropped.md',
    )
    // webUtils.getPathForFile returns '' for a clipboard bitmap; the old port let
    // that empty string flow onward as if it were a path.
    expect(await createDocsAttachmentsPort(createFakeBridge('').bridge).refForFile(file)).toBeNull()
  })
})

describe('createDocsTabsPort', () => {
  it('drops the bridge Docs infix', async () => {
    const { bridge, calls } = createFakeBridge()
    const port = createDocsTabsPort(bridge)

    await port.openNewTab('/docs/notes.docx')
    expect(await port.listTabs()).toEqual([{ id: 't1', title: 'notes.docx', focused: true }])
    await port.focusTab('t1')

    expect(calls).toEqual([
      { method: 'openNewTab', args: ['/docs/notes.docx'] },
      { method: 'listDocsTabs', args: [] },
      { method: 'focusDocsTab', args: ['t1'] },
    ])
  })
})

describe('createDocsCloseSavePort', () => {
  it('delivers close-save requests, replies, and unsubscribes', () => {
    const { bridge, calls, listeners } = createFakeBridge()
    const port = createDocsCloseSavePort(bridge)

    let asked = 0
    const off = port.onCloseSaveRequest(() => (asked += 1))
    listeners.closeSave.forEach((fn) => (fn as () => void)())
    expect(asked).toBe(1)

    port.reportCloseSaveResult(true)
    expect(calls).toEqual([{ method: 'reportCloseSaveResult', args: [true] }])

    off()
    expect(listeners.closeSave).toHaveLength(0)
  })
})
