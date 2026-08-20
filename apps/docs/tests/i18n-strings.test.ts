/** Key parity across the 19 dictionaries. */
import { describe, expect, it } from 'vitest'
import { LANGS } from '@samugen/i18n'
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
  // `appCompareWithPrefix` is legitimately '' in ja and ko, where the surrounding phrase needs no
  // leading word.
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

  // The two strings the web host's save path needs.
  it.each([...LANGS])('locale %s can warn about an externally modified file', (lang) => {
    expect(dicts[lang]!.appSaveExtModified, lang).toBeTruthy()
  })

  it.each([...LANGS])('locale %s can report that a new document is not autosaved', (lang) => {
    expect(dicts[lang]!.appSaveNeedsLocation, lang).toBeTruthy()
  })

  // The pagination preview's Print button, which only a host that prints through the renderer ever
  // renders — i.e.
  it.each([...LANGS])('locale %s can label the browser print button', (lang) => {
    expect(dicts[lang]!.appPrint, lang).toBeTruthy()
    expect(dicts[lang]!.appPvPrintTip, lang).toBeTruthy()
  })
})
