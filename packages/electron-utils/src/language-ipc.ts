/**
 * The `app:*-language` channels, registered in one place.
 *
 * Every editor module used to register `app:get-language` itself, with the
 * comment "shared with the other editor modules — last (identical) registration
 * wins". That works while the handlers really are identical, and it stops
 * working the moment one of them has to do more than the others: in the shell a
 * language switch is persisted to app-settings.json and the native menus are
 * rebuilt, while a standalone editor has neither. Registration order is not
 * something the modules control — the shell registers docs' channels at module
 * load and sheets'/slides'/pdf's when their first tab opens — so "last wins"
 * would decide which behaviour the app got.
 *
 * So the registrations stay identical, and what varies moves behind
 * `setLanguageApplier`: the shell installs its applier once, and whichever
 * module registered last still does the shell's work.
 *
 * Electron is imported for types only, as everywhere else in this package —
 * `ipcMain` and the live WebContents list are passed in, which is also what
 * lets the tests drive this without an Electron runtime.
 */
import type { IpcMain, WebContents } from 'electron'
import { getUiLang, isLang, setUiLang, type Lang } from '@genoffice/i18n'

/** IPC channel names, shared with each app's preload. */
export const LANGUAGE_CHANNELS = {
  get: 'app:get-language',
  set: 'app:set-language',
  changed: 'app:language-changed',
} as const

/**
 * What a language switch does beyond moving the process-wide value.
 *
 * The default is the whole of it for a standalone editor: nothing to persist,
 * because a standalone editor has no settings file of its own, and no menus
 * built from the language that it does not rebuild from `onUiLangChange`.
 */
let applyLanguage: (lang: Lang) => void = setUiLang

/** The shell's richer applier: persist to app-settings.json and rebuild menus. */
export function setLanguageApplier(apply: (lang: Lang) => void): void {
  applyLanguage = apply
}

/** Restore the standalone applier. For tests, which must not leak into each other. */
export function resetLanguageApplier(): void {
  applyLanguage = setUiLang
}

/**
 * Apply a language switch and tell every renderer about it.
 *
 * Exported because the shell's own `home:set-language` channel is a second
 * doorway into the same room — the home page had a language menu long before
 * the editors had a switcher — and both must end up doing exactly one thing.
 *
 * Returns whether anything changed, so a caller can skip follow-up work.
 */
export function applyLanguageChange(lang: unknown, targets: readonly WebContents[]): boolean {
  if (!isLang(lang) || lang === getUiLang()) return false
  applyLanguage(lang)
  // The sender is included: a renderer applies its own switch locally and
  // ignores the echo, which is the contract `LanguagePort` documents. Filtering
  // the sender out here would make the shell's home page a special case instead.
  for (const contents of targets) contents.send(LANGUAGE_CHANNELS.changed, lang)
  return true
}

/**
 * Register the language channels for this process.
 *
 * Safe to call from every module that might be the only one loaded: the
 * handlers are replaced rather than added, and they are the same handlers.
 *
 * `liveWebContents` is read at send time rather than captured, because the
 * windows that must hear about a switch are the ones open when it happens.
 */
export function registerLanguageIpc(
  ipcMain: IpcMain,
  liveWebContents: () => readonly WebContents[],
): void {
  ipcMain.removeHandler(LANGUAGE_CHANNELS.get)
  ipcMain.handle(LANGUAGE_CHANNELS.get, () => getUiLang())
  ipcMain.removeHandler(LANGUAGE_CHANNELS.set)
  ipcMain.handle(LANGUAGE_CHANNELS.set, (_event, lang: unknown) => {
    applyLanguageChange(lang, liveWebContents())
  })
}
