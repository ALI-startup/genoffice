/** Public surface of the HWP conversion service. */
export {
  convertHwpToHwpx,
  converterAvailable,
  looksLikeHwp,
  spawnJava,
  DEFAULT_TIMEOUT_MS,
  VENDORED_JAR,
} from './convert.js'
export type { ConvertOptions, ConvertResult, JavaRun, RunJava } from './convert.js'

export { createHwpConvertHandler, createHwpConvertServer, MAX_BODY_BYTES } from './server.js'
export type { HwpConvertOptions } from './server.js'

export { DEFAULT_HOST, DEFAULT_PORT, loadConvertConfig, startHwpConvert } from './main.js'
export type { Env, HwpConvertConfig, RunningHwpConvert } from './main.js'
