/**
 * The settings dialog's copy, which was the last screen reachable from home
 * still in English whatever the UI language said.
 *
 * The settings overlay deliberately lets a locale fall back to the English
 * wording (see the comment above it in strings.ts), so key parity — which
 * strings.test.ts already asserts — cannot tell a translated table from an
 * aliased one. These assert the translation itself.
 */
import { describe, expect, it } from 'vitest'
import { AI_PROVIDER_DEFINITIONS } from '../src/shared/ai-settings-api'
import { providerDescription } from '../src/renderer/src/provider-descriptions'
import { strings } from '../src/renderer/src/strings'

/** The settings keys, identified by what only the settings overlay defines. */
const SETTINGS_KEYS = [
  'settingsTitle',
  'closeSettings',
  'settingsNavigationLabel',
  'generalSettings',
  'generalSettingsDescription',
  'languageSettingHint',
  'aiProvidersTitle',
  'aiProvidersDescription',
  'aiSaveProvider',
  'aiTestConnection',
  'aiApiKeyLabel',
  'aiSettingsSaved',
] as const

const HANGUL = /[가-힣]/

describe('the settings dialog in Korean', () => {
  it.each(SETTINGS_KEYS)('translates %s rather than falling back to English', (key) => {
    const value = strings.ko[key]
    expect(value).not.toBe(strings.en[key])
    expect(value, key).toMatch(HANGUL)
  })

  it('translates every settings string, not just the ones spot-checked above', () => {
    // The overlay's whole key set: anything the English table has that the base
    // tables do not. `ja` still aliases English, which is what makes this a
    // meaningful comparison rather than a tautology.
    const overlayKeys = (Object.keys(strings.en) as Array<keyof typeof strings.en>).filter(
      (key) => strings.ja[key] === strings.en[key] && strings.zh[key] !== strings.en[key],
    )
    const untranslated = overlayKeys.filter((key) => strings.ko[key] === strings.en[key])
    expect(untranslated).toEqual([])
  })

  it('keeps the placeholder in the one settings string that has one', () => {
    expect(strings.ko.aiModelsAvailable).toContain('{count}')
  })
})

describe('provider descriptions', () => {
  it('covers every provider the settings screen can show', () => {
    const missing = AI_PROVIDER_DEFINITIONS.filter(
      (definition) =>
        providerDescription('ko', definition.id, definition.description) === definition.description,
    ).map((definition) => definition.id)
    expect(missing).toEqual([])
  })

  it('falls back to the snapshot wording for a language with no overlay', () => {
    // The point of the overlay: English lives once, on the wire, and a locale
    // without a translation shows it rather than `undefined`.
    expect(providerDescription('fr', 'openai', 'OpenAI models through the official API.')).toBe(
      'OpenAI models through the official API.',
    )
    expect(providerDescription('ko', 'not-a-provider', 'fallback')).toBe('fallback')
  })
})
