import { describe, expect, it } from 'vitest'
import {
  createWebLanguagePort,
  LANGUAGE_STORAGE_KEY,
  setWebLanguage,
  type LanguageHostEnv,
} from '../src/language'

function fakeEnv(
  locale = 'en-US',
  stored?: string,
): LanguageHostEnv & { emit(value: string | null): void } {
  const values = new Map<string, string>()
  if (stored !== undefined) values.set(LANGUAGE_STORAGE_KEY, stored)
  const listeners = new Set<(event: StorageEvent) => void>()
  return {
    locale,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    },
    addEventListener: (_type, handler) => void listeners.add(handler),
    removeEventListener: (_type, handler) => void listeners.delete(handler),
    emit(value) {
      const event = { key: LANGUAGE_STORAGE_KEY, newValue: value } as StorageEvent
      for (const listener of listeners) listener(event)
    },
  }
}

describe('getLanguage', () => {
  it('falls back to the browser locale, normalised to a supported Lang', async () => {
    await expect(createWebLanguagePort(fakeEnv('zh-TW')).getLanguage()).resolves.toBe('zh-TW')
    await expect(createWebLanguagePort(fakeEnv('de-AT')).getLanguage()).resolves.toBe('de')
  })

  it('prefers a stored choice over the browser locale', async () => {
    await expect(createWebLanguagePort(fakeEnv('en-US', 'ja')).getLanguage()).resolves.toBe('ja')
  })

  it('degrades to the browser locale when storage is unreadable', async () => {
    const env = fakeEnv('ko-KR')
    env.storage.getItem = () => {
      throw new Error('storage blocked')
    }

    await expect(createWebLanguagePort(env).getLanguage()).resolves.toBe('ko')
  })
})

describe('onLanguageChanged', () => {
  it('emits when another tab changes the language, and stops after unsubscribe', () => {
    const env = fakeEnv('en-US')
    const port = createWebLanguagePort(env)
    const seen: string[] = []
    const off = port.onLanguageChanged((lang) => seen.push(lang))

    setWebLanguage(env, 'fr')
    env.emit('fr')
    expect(seen).toEqual(['fr'])

    off()
    env.emit('ru')
    expect(seen).toEqual(['fr'])
  })
})
