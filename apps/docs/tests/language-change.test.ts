/** Changing the UI language, end to end through the locale context. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Lang } from '@samugen/i18n'
import { LocaleProvider, useI18n } from '../src/renderer/i18n/locale'
import { setDocsPlatform, type DocsPlatform } from '../src/renderer/platform'

interface FakeHost {
  set: Lang[]
  emit(lang: Lang): void
  subscribers: number
}

function installHost(): FakeHost {
  const listeners = new Set<(lang: Lang) => void>()
  const set: Lang[] = []
  setDocsPlatform({
    language: {
      getLanguage: async () => 'en',
      setLanguage: async (lang: Lang) => void set.push(lang),
      onLanguageChanged: (handler: (lang: Lang) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
  } as unknown as DocsPlatform)
  return {
    set,
    emit: (lang) => act(() => listeners.forEach((listener) => listener(lang))),
    get subscribers() {
      return listeners.size
    },
  }
}

/** Set by <Probe/> on every render, so a test can switch from outside React. */
let switchTo: ((lang: Lang) => void) | null = null

/** Renders a translated string and exposes the switch, so both halves are observable. */
function Probe() {
  const { t, setLang } = useI18n()
  const ref = useRef(setLang)
  ref.current = setLang
  switchTo = (lang) => act(() => ref.current(lang))
  return createElement('span', { className: 'probe' }, t('appSave'))
}

function mount(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    probe: () => container.querySelector('.probe')?.textContent,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
      switchTo = null
    },
  }
}

function tree(initial: Lang) {
  return createElement(LocaleProvider, { initial, children: createElement(Probe) })
}

/** The switch, once the tree that owns it is mounted. */
function setLang(lang: Lang) {
  if (!switchTo) throw new Error('nothing mounted')
  switchTo(lang)
}

afterEach(() => vi.restoreAllMocks())

describe('changing the UI language', () => {
  it('repaints the UI in Korean and tells the host, in one call', () => {
    const host = installHost()
    const ui = mount(tree('en'))
    expect(ui.probe()).toBe('Save')

    setLang('ko')

    // Applied locally — not awaited back from the host, which never echoes.
    expect(ui.probe()).toBe('저장')
    // And persisted for every other window/tab.
    expect(host.set).toEqual(['ko'])
    // The lang attribute drives CSS :lang() and Chromium's font fallback, which
    // is what picks the Korean UI face.
    expect(document.documentElement.lang).toBe('ko-KR')
    ui.cleanup()
  })

  it('reaches any of the nineteen, not just the two the old switch offered', () => {
    const host = installHost()
    const ui = mount(tree('en'))

    setLang('zh-TW')

    expect(ui.probe()).toBe('儲存')
    expect(host.set).toEqual(['zh-TW'])
    expect(document.documentElement.lang).toBe('zh-TW')
    ui.cleanup()
  })

  it('ignores a switch to the language already showing', () => {
    const host = installHost()
    const ui = mount(tree('ko'))

    setLang('ko')
    expect(host.set).toEqual([])
    ui.cleanup()
  })

  it('follows a switch made in another window, and unsubscribes when unmounted', () => {
    const host = installHost()
    const ui = mount(tree('en'))
    expect(host.subscribers).toBe(1)

    host.emit('ko')
    expect(ui.probe()).toBe('저장')
    // Nothing was sent back: this window was told, it did not ask.
    expect(host.set).toEqual([])

    ui.cleanup()
    expect(host.subscribers).toBe(0)
  })
})
