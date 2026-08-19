import type { Lang } from '@genoffice/i18n'

/**
 * The English ⇄ Korean switch that sits in every app's chrome.
 *
 * Two segments rather than a nineteen-item menu, because these two are the
 * pair people move between all day: a menu costs a click to open, a read to
 * find the row, and a second click, and it hides which language is current
 * behind all three. The full list is still where it always was — the shell's
 * account menu — and this control is deliberately not a replacement for it.
 *
 * The labels are endonyms and are never translated: 'EN' and '한국어' say the
 * same thing to a reader of either language, which is exactly what a language
 * switch has to do for someone stranded in the language they cannot read. Same
 * reasoning as the shell's language list, which has always been in-script.
 *
 * A third language being current — the app supports nineteen — leaves neither
 * segment pressed. That is honest: the control reports the state it can, and
 * offers the two switches it makes, rather than claiming one of them is on.
 *
 * Style classes (`lang-toggle`, `lang-toggle-option`, `.active`) are provided
 * by each app's own stylesheet, as the rest of this package's components are.
 */

/** The two the control offers. Exported so a caller can label or test them. */
export const LANGUAGE_TOGGLE_OPTIONS: readonly { value: Lang; label: string; title: string }[] = [
  { value: 'en', label: 'EN', title: 'English' },
  { value: 'ko', label: '한국어', title: '한국어' },
]

export interface LanguageToggleProps {
  /** The current UI language — any of the nineteen, not only these two. */
  lang: Lang
  /** Called only for a language that is not already current. */
  onChange: (lang: Lang) => void
  /** Accessible name for the group, translated by the caller ("Language" / "언어"). */
  label: string
  /** Extra class for an app that needs to place it, e.g. 'lang-toggle-tabbar'. */
  className?: string
}

export function LanguageToggle({ lang, onChange, label, className }: LanguageToggleProps) {
  return (
    <div
      className={className ? `lang-toggle ${className}` : 'lang-toggle'}
      role="group"
      aria-label={label}
    >
      {LANGUAGE_TOGGLE_OPTIONS.map((option) => {
        const active = lang === option.value
        return (
          <button
            key={option.value}
            type="button"
            // A radio group, not a set of toggles: exactly one of these is the
            // UI language, and a screen reader should say which.
            role="radio"
            aria-checked={active}
            className={active ? 'lang-toggle-option active' : 'lang-toggle-option'}
            title={`${label}: ${option.title}`}
            lang={option.value}
            onClick={() => {
              if (!active) onChange(option.value)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
