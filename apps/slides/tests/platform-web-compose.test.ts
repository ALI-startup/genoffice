/** The composed browser platform (`createWebSlidesPlatform`). */
import { describe, expect, it, vi } from 'vitest'
import type { AiPort, AttachmentsPort, LanguagePort } from '@samugen/platform'
import type { WebDocumentStore } from '@samugen/platform-web'
import { setSlideRenderEnv } from '../src/domain/session'
import {
  createWebSlidesPlatform,
  WebSlidesSession,
  type WebSlidesPlatformDeps,
} from '../src/renderer/platform-web'

const metrics = {
  metrics: (style: { fontSizePx: number }) => ({
    ascent: style.fontSizePx * 0.8,
    descent: style.fontSizePx * 0.2,
    lineHeight: style.fontSizePx * 1.2,
  }),
  measure: (text: string, style: { fontSizePx: number }) => text.length * style.fontSizePx * 0.5,
}

const attachments = { pickAttachments: vi.fn() } as unknown as AttachmentsPort

function build(overrides: Partial<WebSlidesPlatformDeps> = {}) {
  setSlideRenderEnv({ metrics, decodeTiff: null })
  return createWebSlidesPlatform({
    session: new WebSlidesSession(),
    store: {} as unknown as WebDocumentStore,
    pickers: { openFile: vi.fn(), saveFile: vi.fn(), directory: vi.fn() },
    language: {
      getLanguage: async () => 'en',
      setLanguage: async () => {},
      onLanguageChanged: () => () => {},
    } as LanguagePort,
    ai: {
      getAiSettings: vi.fn(),
      aiStream: vi.fn(),
      aiStreamCancel: vi.fn(),
      onAiStream: () => () => {},
    } as unknown as AiPort,
    attachments,
    document: {
      commentAuthor: () => 'User',
      translate: (key) => key,
      confirmChartSimplify: async () => true,
    },
    imageSize: async () => null,
    download: () => {},
    printFrame: async () => {},
    // The real one installs a `beforeunload` listener; a test does not need the window.
    unloadPrompt: () => () => {},
    ...overrides,
  })
}

describe('createWebSlidesPlatform', () => {
  it('backs all eight required ports', () => {
    const platform = build()
    for (const port of [
      'doc',
      'file',
      'deckClipboard',
      'window',
      'language',
      'ai',
      'print',
      'attachments',
    ] as const) {
      expect(platform[port], port).toBeTruthy()
    }
    // Not rebuilt or wrapped: the attachments port is host-supplied and passed straight in,
    // which is what lets the same one serve both hosts.
    expect(platform.attachments).toBe(attachments)
  })

  it('answers null for every capability a browser does not have', () => {
    const platform = build()
    // Each of these is a real gap, listed in platform.ts with the reason: a second screen, a PDF
    // writer, the system clipboard, a provider credential, a server-side generator, a filesystem of
    // templates, a native menu bar — plus `project`, whose store is a main-process database (§6.1).
    expect({
      presenter: platform.presenter,
      aiMedia: platform.aiMedia,
      pdfExport: platform.pdfExport,
      clipboard: platform.clipboard,
      search: platform.search,
      styleTemplates: platform.styleTemplates,
      menu: platform.menu,
      project: platform.project,
    }).toEqual({
      presenter: null,
      aiMedia: null,
      pdfExport: null,
      clipboard: null,
      search: null,
      styleTemplates: null,
      menu: null,
      project: null,
    })
  })

  it('gives every port the same session, so an edit through one is visible to the others', async () => {
    const platform = build()
    expect(await platform.window.isDirty()).toBe(false)
    await platform.file.newBlank(960)
    const slides = await platform.doc.getRenderSlides()
    expect(slides).toHaveLength(1)
    await platform.doc.addBlankSlide({ sourceIndex: 0, fitWidthPx: 960 })
    expect(await platform.doc.getRenderSlides()).toHaveLength(2)
    // A comment proves two things at once: the document port asks the host who the author
    // is, and the window port reads the same session the document port just wrote to.
    const comments = await platform.doc.addComment({ slideIndex: 0, text: 'from the page' })
    expect(comments?.[0]).toMatchObject({ author: 'User', text: 'from the page' })
    expect(await platform.window.isDirty()).toBe(true)
  })
})
