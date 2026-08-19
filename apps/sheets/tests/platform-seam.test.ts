/**
 * The host seam itself: what the slot promises, and what the composition claims.
 *
 * Two things are worth a test rather than a comment. The slot must fail loudly when no host
 * has been installed — a renderer module reaching a half-built platform is exactly the bug
 * the slot exists to make impossible — and the composition must be explicit about the
 * capabilities it cannot back: `null`, never a stub that type-checks and then fails at the
 * call site. A port quietly becoming a no-op object is the failure this file guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiPort, AttachmentsPort, LanguagePort } from '@samugen/platform'
import type { FilePickers } from '@samugen/platform-web'
import type { XlsxWorkerClient } from '../src/renderer/wasm/client'
import { createWebSheetsPlatform } from '../src/renderer/platform-web'
import {
  setSheetsPlatform,
  sheetsAi,
  sheetsLanguage,
  sheetsWindow,
  sheetsWorkbook,
} from '../src/renderer/platform'

afterEach(() => vi.restoreAllMocks())

/** The dependencies the composition takes, each one a recorder and nothing more. */
function fakeDeps() {
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return undefined as never
    }
  const client = { recalc: record('recalc'), close: record('close') } as unknown as XlsxWorkerClient
  const language = {
    getLanguage: () => Promise.resolve('ko'),
    onLanguageChanged: () => () => {},
    setLanguage: record('setLanguage'),
  } as unknown as LanguagePort
  const ai = {
    aiStream: record('aiStream'),
    aiStreamCancel: record('aiStreamCancel'),
    onAiStream: () => () => {},
  } as unknown as AiPort
  return {
    calls,
    deps: {
      client,
      language,
      ai,
      pickers: {} as FilePickers,
      attachments: {} as AttachmentsPort,
      confirmOverwrite: () => true,
      unloadPrompt: (() => () => {}) as never,
    },
  }
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

describe('the browser composition', () => {
  it('backs the ports it can and answers null for the four it cannot', () => {
    const platform = createWebSheetsPlatform(fakeDeps().deps)

    for (const port of ['workbook', 'file', 'window', 'language', 'ai', 'attachments'] as const) {
      expect(platform[port], port).toBeTruthy()
    }
    // A native menu bar, a PDF writer, a search service with its own credential and a
    // project database in a main process: none of them exist here, and each says so.
    for (const port of ['menu', 'pdfExport', 'search', 'project'] as const) {
      expect(platform[port], port).toBeNull()
    }
  })

  it('routes each accessor to the dependency behind it', async () => {
    const { calls, deps } = fakeDeps()
    setSheetsPlatform(createWebSheetsPlatform(deps))

    sheetsAi().aiStreamCancel('r1')
    expect(await sheetsLanguage().getLanguage()).toBe('ko')
    // The window port is real here even though there is no native window: unsaved work is
    // guarded through `beforeunload` instead, which is why the prompt is injectable.
    expect(sheetsWindow().notifyPendingEdits).toBeTypeOf('function')

    expect(calls.map((call) => call.method)).toEqual(['aiStreamCancel'])
  })

  it('fails closed on a workbook it has no session for', async () => {
    setSheetsPlatform(createWebSheetsPlatform(fakeDeps().deps))

    // Unlike the desktop, where the main process owned the open workbook, the session lives
    // in this page — so a request naming one it does not have is a bug to surface, not an
    // empty recalculation to hand back.
    await expect(
      sheetsWorkbook().recalcWorkbook({ sessionId: 'gone', edits: [] } as never),
    ).rejects.toThrow(/session/i)
  })
})
