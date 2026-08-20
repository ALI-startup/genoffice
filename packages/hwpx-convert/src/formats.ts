/** The two Hangul Word Processor file names, and the one place that knows them apart. */

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

/** The `.hwpx` name a file takes once it has been read or converted. */
export function hwpxNameFor(name: string): string {
  if (isHwpxName(name)) return name
  const stem = name.replace(/\.[^./\\]*$/, '')
  return `${stem || name}${HWPX_EXT}`
}
