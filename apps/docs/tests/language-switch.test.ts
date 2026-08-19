/**
 * The English ⇄ Korean switch, end to end through the locale context.
 *
 * The point of the test is the second half: a click has to repaint the UI in the
 * language just chosen, and it cannot wait for the host to say so — no host
 * echoes a switch back to the window that asked (see LanguagePort). A version of
 * this that only asserted `setLanguage` was called would pass while the UI stayed
 * in English, which is the bug worth catching.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Lang } from '@samugen/i18n'
import { LangSwitch } from '../src/renderer/components/LangSwitch'
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

function mount(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    options: () => [...container.querySelectorAll<HTMLButtonElement>('.lang-toggle-option')],
    click: (label: string) => {
      const button = [...container.querySelectorAll<HTMLButtonElement>('.lang-toggle-option')].find(
        (option) => option.textContent === label,
      )
      if (!button) throw new Error(`no ${label} option`)
      act(() => button.click())
    },
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

/** Renders a translated string alongside the switch, so a switch is observable. */
function Probe() {
  const { t } = useI18n()
  return createElement('span', { className: 'probe' }, t('appSave'))
}

function tree(initial: Lang) {
  return createElement(LocaleProvider, {
    initial,
    children: [
      createElement(LangSwitch, { key: 'switch' }),
      createElement(Probe, { key: 'probe' }),
    ],
  })
}

afterEach(() => vi.restoreAllMocks())

describe('the language switch', () => {
  it('offers exactly the two languages, marking the current one', () => {
    installHost()
    const ui = mount(tree('en'))

    expect(ui.options().map((option) => option.textContent)).toEqual(['EN', '한국어'])
    expect(ui.options().map((option) => option.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
    ])
    ui.cleanup()
  })

  it('repaints the UI in Korean and tells the host, on one click', () => {
    const host = installHost()
    const ui = mount(tree('en'))
    expect(ui.container.querySelector('.probe')?.textContent).toBe('Save')

    ui.click('한국어')

    // Applied locally — not awaited back from the host, which never echoes.
    expect(ui.container.querySelector('.probe')?.textContent).toBe('저장')
    expect(ui.options()[1]?.getAttribute('aria-checked')).toBe('true')
    // And persisted for every other window/tab.
    expect(host.set).toEqual(['ko'])
    // The lang attribute drives CSS :lang() and Chromium's font fallback, which
    // is what picks the Korean UI face.
    expect(document.documentElement.lang).toBe('ko-KR')
    ui.cleanup()
  })

  it('ignores a click on the language already showing', () => {
    const host = installHost()
    const ui = mount(tree('ko'))

    ui.click('한국어')
    expect(host.set).toEqual([])
    ui.cleanup()
  })

  it('follows a switch made in another window, and unsubscribes when unmounted', () => {
    const host = installHost()
    const ui = mount(tree('en'))
    expect(host.subscribers).toBe(1)

    host.emit('ko')
    expect(ui.container.querySelector('.probe')?.textContent).toBe('저장')
    // Nothing was sent back: this window was told, it did not ask.
    expect(host.set).toEqual([])

    ui.cleanup()
    expect(host.subscribers).toBe(0)
  })

  it('marks neither option when a third language is showing', () => {
    installHost()
    // The app has nineteen languages and this control offers two of them. With
    // Japanese current it reports what it can rather than claiming one is on.
    const ui = mount(tree('ja'))
    expect(ui.options().map((option) => option.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
    ])
    ui.cleanup()
  })
})
