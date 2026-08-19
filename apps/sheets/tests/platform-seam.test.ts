/**
 * The host seam itself: what the slot promises, and what the Electron composition claims.
 *
 * Two things are worth a test rather than a comment. The slot must fail loudly when no host
 * has been installed — a renderer module reaching a half-built platform is exactly the bug
 * the slot exists to make impossible — and the Electron composition must claim *every*
 * capability, because it is the host that has them all. A `null` creeping into it would
 * silently disable a piece of the desktop app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectApi } from '@genoffice/project-store'
import type { DesktopApi } from '../src/shared/desktop-api'
import { createElectronSheetsPlatform } from '../src/renderer/platform-electron'
import {
  setSheetsPlatform,
  sheetsAi,
  sheetsAttachments,
  sheetsFile,
  sheetsLanguage,
  sheetsWindow,
  sheetsWorkbook,
} from '../src/renderer/platform'

afterEach(() => vi.restoreAllMocks())

/** A bridge that records calls; every member the seam uses, and nothing else. */
function fakeBridge() {
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return undefined as never
    }
  const attachment = { path: '/tmp/notes.md', name: 'notes.md', ext: 'md', sizeBytes: 12 }
  const bridge = {
    readWorkbookRange: record('readWorkbookRange'),
    readWorkbookFormulas: record('readWorkbookFormulas'),
    recalcWorkbook: record('recalcWorkbook'),
    readWorkbookMedia: record('readWorkbookMedia'),
    readPivotDefinition: record('readPivotDefinition'),
    selectWorkbook: record('selectWorkbook'),
    saveWorkbookEdits: record('saveWorkbookEdits'),
    writeWorkbookRecovery: record('writeWorkbookRecovery'),
    autoRenameWorkbook: record('autoRenameWorkbook'),
    closeWorkbook: record('closeWorkbook'),
    consumeNewBlankWorkbook: record('consumeNewBlankWorkbook'),
    readLocalImage: record('readLocalImage'),
    notifyPendingEdits: record('notifyPendingEdits'),
    onCloseSaveRequest: record('onCloseSaveRequest'),
    reportCloseSaveResult: record('reportCloseSaveResult'),
    onWorkbookRenamed: record('onWorkbookRenamed'),
    openExternal: record('openExternal'),
    getLanguage: async () => 'ko' as const,
    onLanguageChanged: record('onLanguageChanged'),
    getAiSettings: record('getAiSettings'),
    aiStream: record('aiStream'),
    aiStreamCancel: record('aiStreamCancel'),
    onAiStream: record('onAiStream'),
    onMenuAction: record('onMenuAction'),
    exportPdf: record('exportPdf'),
    aiGskStatus: record('aiGskStatus'),
    aiGskLogin: record('aiGskLogin'),
    webSearch: record('webSearch'),
    pickAttachments: async () => ({ accepted: [attachment], rejected: [] }),
    addAttachmentPaths: async () => ({ accepted: [attachment], rejected: ['too-big.bin'] }),
    addPastedImage: async () => ({ accepted: [attachment], rejected: [] }),
    readAttachment: record('readAttachment'),
    readAttachmentImage: record('readAttachmentImage'),
    getPathForFile: () => '/tmp/dropped.md',
  }
  return { calls, attachment, bridge: bridge as unknown as DesktopApi }
}

describe('the platform slot', () => {
  it('throws rather than answering before a host is installed', async () => {
    // A fresh module, because this file installs a host in the tests below and the slot is
    // module state: the unset case only exists before the first `set`.
    vi.resetModules()
    const fresh = await import('../src/renderer/platform')
    expect(() => fresh.sheetsPlatform()).toThrow(/sheets/)
  })
})

describe('the Electron composition', () => {
  it('claims every capability, including the five a browser cannot', () => {
    const project = {} as ProjectApi
    const platform = createElectronSheetsPlatform(fakeBridge().bridge, project)
    for (const port of [
      'workbook',
      'file',
      'window',
      'language',
      'ai',
      'attachments',
      'menu',
      'pdfExport',
      'search',
    ] as const) {
      expect(platform[port], port).toBeTruthy()
    }
    expect(platform.project).toBe(project)
  })

  it('routes each accessor to the bridge member behind it', async () => {
    const { calls, bridge } = fakeBridge()
    setSheetsPlatform(createElectronSheetsPlatform(bridge, null))

    sheetsWorkbook().recalcWorkbook({} as never)
    sheetsFile().closeWorkbook('s1')
    sheetsWindow().notifyPendingEdits(3)
    sheetsAi().aiStreamCancel('r1')
    expect(await sheetsLanguage().getLanguage()).toBe('ko')

    expect(calls).toEqual([
      { method: 'recalcWorkbook', args: [{}] },
      { method: 'closeWorkbook', args: ['s1'] },
      { method: 'notifyPendingEdits', args: [3] },
      { method: 'aiStreamCancel', args: ['r1'] },
    ])
  })

  it('maps the path-based attachment bridge onto refs', async () => {
    const { bridge, attachment } = fakeBridge()
    setSheetsPlatform(createElectronSheetsPlatform(bridge, null))

    // The last of the three apps to make this collapse (§6.3). A ref *is* the path on this
    // host, and the path also stays as the chip's tooltip, so the desktop UI is unchanged.
    await expect(sheetsAttachments().pickAttachments()).resolves.toEqual({
      accepted: [
        {
          ref: attachment.path,
          name: attachment.name,
          ext: attachment.ext,
          sizeBytes: attachment.sizeBytes,
          location: attachment.path,
        },
      ],
      rejected: [],
    })
    // A File the bridge cannot name became an explicit null instead of an empty string that
    // type-checks as a path — the whole reason the port was reshaped.
    await expect(sheetsAttachments().refForFile(new File([], 'x.png'))).resolves.toBe(
      '/tmp/dropped.md',
    )
  })
})
