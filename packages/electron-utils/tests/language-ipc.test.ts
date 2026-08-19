/**
 * The language channels: what a switch does, and who hears about it.
 *
 * The applier hook is the part worth a test rather than a comment. Five modules
 * register these handlers and the last one wins, so the thing that must hold is
 * that "last" cannot change the behaviour — the shell installs its applier once
 * and every registration routes through it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUiLang, setUiLang, type Lang } from '@genoffice/i18n'
import type { IpcMain, WebContents } from 'electron'
import {
  applyLanguageChange,
  LANGUAGE_CHANNELS,
  registerLanguageIpc,
  resetLanguageApplier,
  setLanguageApplier,
} from '../src/language-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** Just enough ipcMain to record what was registered and to invoke it. */
function fakeIpcMain() {
  const handlers = new Map<string, Handler>()
  const removed: string[] = []
  const ipcMain = {
    handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
    removeHandler: (channel: string) => {
      removed.push(channel)
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.(null, ...args)
  return { ipcMain, handlers, removed, invoke }
}

/** A window that records what was pushed to it. */
function fakeWindow() {
  const sent: { channel: string; lang: unknown }[] = []
  const contents = {
    send: (channel: string, lang: unknown) => void sent.push({ channel, lang }),
  } as unknown as WebContents
  return { contents, sent }
}

afterEach(() => {
  resetLanguageApplier()
  setUiLang('zh')
  vi.restoreAllMocks()
})

describe('registerLanguageIpc', () => {
  it('replaces its handlers rather than adding to them, so registering twice is safe', () => {
    const { ipcMain, handlers, removed } = fakeIpcMain()
    registerLanguageIpc(ipcMain, () => [])
    registerLanguageIpc(ipcMain, () => [])

    expect([...handlers.keys()].sort()).toEqual([LANGUAGE_CHANNELS.get, LANGUAGE_CHANNELS.set])
    // Every module that might be the only one loaded calls this; the second call
    // must not throw the way a bare `ipcMain.handle` would.
    expect(removed).toEqual([
      LANGUAGE_CHANNELS.get,
      LANGUAGE_CHANNELS.set,
      LANGUAGE_CHANNELS.get,
      LANGUAGE_CHANNELS.set,
    ])
  })

  it('answers the current language and switches it', async () => {
    const { ipcMain, invoke } = fakeIpcMain()
    const window = fakeWindow()
    registerLanguageIpc(ipcMain, () => [window.contents])

    setUiLang('en')
    expect(await invoke(LANGUAGE_CHANNELS.get)).toBe('en')

    invoke(LANGUAGE_CHANNELS.set, 'ko')
    expect(getUiLang()).toBe('ko')
    expect(await invoke(LANGUAGE_CHANNELS.get)).toBe('ko')
  })

  it('tells every live window, including the one that asked', () => {
    const { ipcMain, invoke } = fakeIpcMain()
    const asker = fakeWindow()
    const other = fakeWindow()
    registerLanguageIpc(ipcMain, () => [asker.contents, other.contents])

    setUiLang('en')
    invoke(LANGUAGE_CHANNELS.set, 'ko')

    // The sender is not filtered out: a renderer applies its own switch locally
    // and ignores the echo, which is the contract LanguagePort documents.
    for (const window of [asker, other]) {
      expect(window.sent).toEqual([{ channel: LANGUAGE_CHANNELS.changed, lang: 'ko' }])
    }
  })

  it('reads the window list at send time, not at registration', () => {
    const { ipcMain, invoke } = fakeIpcMain()
    const windows: WebContents[] = []
    registerLanguageIpc(ipcMain, () => windows)

    // A window opened after the handlers were registered — which is every editor
    // tab, since the shell registers these at module load.
    const late = fakeWindow()
    windows.push(late.contents)

    setUiLang('en')
    invoke(LANGUAGE_CHANNELS.set, 'ko')
    expect(late.sent).toHaveLength(1)
  })

  it('ignores a value that is not a language, and a switch to the current one', () => {
    const { ipcMain, invoke } = fakeIpcMain()
    const window = fakeWindow()
    registerLanguageIpc(ipcMain, () => [window.contents])

    setUiLang('ko')
    invoke(LANGUAGE_CHANNELS.set, 'klingon')
    invoke(LANGUAGE_CHANNELS.set, null)
    invoke(LANGUAGE_CHANNELS.set, 'ko')

    expect(getUiLang()).toBe('ko')
    expect(window.sent).toEqual([])
  })
})

describe('the applier', () => {
  it("routes through the shell's applier whichever module registered last", () => {
    const applied: Lang[] = []
    setLanguageApplier((lang) => {
      applied.push(lang)
      setUiLang(lang)
    })

    // Two modules register, as the shell and an editor both do. The handler the
    // second one installed is the one that answers, and it still does the
    // shell's work: that is the whole point of the hook.
    const { ipcMain, invoke } = fakeIpcMain()
    registerLanguageIpc(ipcMain, () => [])
    registerLanguageIpc(ipcMain, () => [])

    setUiLang('en')
    invoke(LANGUAGE_CHANNELS.set, 'ko')
    expect(applied).toEqual(['ko'])
  })

  it("is what the shell's own home channel goes through too", () => {
    const applied: Lang[] = []
    setLanguageApplier((lang) => {
      applied.push(lang)
      setUiLang(lang)
    })
    const window = fakeWindow()

    setUiLang('en')
    // The home page's language menu calls this directly rather than over
    // 'app:set-language', so one switch means one thing however it was asked for.
    expect(applyLanguageChange('ko', [window.contents])).toBe(true)
    expect(applyLanguageChange('ko', [window.contents])).toBe(false)
    expect(applied).toEqual(['ko'])
    expect(window.sent).toHaveLength(1)
  })
})
