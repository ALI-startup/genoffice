/**
 * Key parity across the 19 dictionaries.
 *
 * `createI18n` looks up `dicts[lang][key]` with no fallback, so a key added to one
 * language and forgotten in another renders as `undefined` for those users at
 * runtime rather than failing the build. Same guard apps/pdf already has.
 */
import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { strings } from '../src/renderer/i18n/strings'

const dicts = strings as Record<string, Record<string, string>>
const zhKeys = Object.keys(dicts.zh!).sort()

describe('i18n string tables', () => {
  it('provides a dictionary for every supported language and nothing else', () => {
    expect(Object.keys(dicts).sort()).toEqual([...LANGS].sort())
  })

  it.each([...LANGS])('locale %s has exactly the zh key set', (lang) => {
    expect(Object.keys(dicts[lang]!).sort()).toEqual(zhKeys)
  })

  // Deliberately not asserting "no empty values", which apps/pdf's version does:
  // `appCompareWithPrefix` is legitimately '' in ja and ko, where the surrounding
  // phrase needs no leading word. An empty string still renders, so the failure
  // mode this file exists to catch is a *missing* key, not a blank one.
  it.each([...LANGS])('locale %s defines every key as a string', (lang) => {
    for (const [key, value] of Object.entries(dicts[lang]!)) {
      expect(typeof value, `${lang}.${key}`).toBe('string')
    }
  })

  it.each([...LANGS])('locale %s keeps the same placeholders as zh', (lang) => {
    for (const key of zhKeys) {
      const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(placeholders(dicts[lang]![key]!), `${lang}.${key}`).toEqual(
        placeholders(dicts.zh![key]!),
      )
    }
  })

  // The two strings the web host's save path needs. They are asserted by name
  // because both are reached only from a browser build: the overwrite prompt and
  // the "this document has nowhere to be saved yet" status.
  it.each([...LANGS])('locale %s can warn about an externally modified file', (lang) => {
    expect(dicts[lang]!.appSaveExtModified, lang).toBeTruthy()
  })

  it.each([...LANGS])('locale %s can report that a new document is not autosaved', (lang) => {
    expect(dicts[lang]!.appSaveNeedsLocation, lang).toBeTruthy()
  })
})
