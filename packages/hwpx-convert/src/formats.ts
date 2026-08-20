/**
 * The two Hangul Word Processor file names, and the one place that knows them apart.
 *
 * `.hwpx` is the OWPML package this codec reads and writes directly — a zip of
 * XML, the format's Open-XML-era successor. `.hwp` is the older HWP 5.0 binary:
 * an OLE compound document with compressed record streams, which nothing in a
 * browser can read. It reaches the editor by being converted to `.hwpx` first
 * (see services/hwp-convert), so every consumer downstream of that conversion
 * only ever deals with the one format.
 *
 * The tests are on the *name* rather than the bytes because that is what the
 * hosts have: a `DocumentRef` is opaque and a file picker hands back a handle,
 * not a type. The name is what the user chose from a dialog already filtered to
 * these extensions, so it is the honest discriminant — and the only one the
 * Electron-era code used, which is why it existed in four copies before this
 * module.
 */

/** Extension of the OWPML package, including the dot. */
export const HWPX_EXT = '.hwpx'

/** Extension of the legacy HWP 5.0 binary, including the dot. */
export const HWP_EXT = '.hwp'

/**
 * Anchored, and `.hwp` deliberately cannot match a `.hwpx`: the two take
 * different paths in (one is read here, the other is converted first), so a
 * prefix match would send an OWPML package through the converter.
 */
const HWPX_NAME = /\.hwpx$/i
const HWP_NAME = /\.hwp$/i

/** True for a name this codec can read and write directly. */
export function isHwpxName(name: string): boolean {
  return HWPX_NAME.test(name)
}

/** True for a name that has to be converted before anything here can read it. */
export function isHwpName(name: string): boolean {
  return HWP_NAME.test(name)
}

/** True for either Hangul format, which is what a file dialog filters to. */
export function isHangulName(name: string): boolean {
  return isHwpxName(name) || isHwpName(name)
}

/**
 * The `.hwpx` name a file takes once it has been read or converted.
 *
 * `report.hwp` becomes `report.hwpx`; a name that already ends in `.hwpx` is
 * returned unchanged rather than gaining a second extension. Anything else keeps
 * its stem and gains `.hwpx`, which is what a `.doc`-style unknown suffix should
 * do — the alternative, appending, produces `notes.txt.hwpx`.
 */
export function hwpxNameFor(name: string): string {
  if (isHwpxName(name)) return name
  const stem = name.replace(/\.[^./\\]*$/, '')
  return `${stem || name}${HWPX_EXT}`
}
