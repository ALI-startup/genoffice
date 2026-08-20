/**
 * Public surface of the HWP conversion service.
 *
 * Two kinds of consumer, and the export list is the union of what they need:
 * `main.ts`, which binds a socket, and tests, which want the request handler
 * without one — `createHwpConvertHandler` is a plain `(req, res)` function so a
 * test can drive it over an ephemeral `node:http` server and assert on real
 * response bodies.
 *
 * `convertHwpToHwpx` is exported too, because it is useful on its own: a script
 * converting a directory of documents has no reason to start a server.
 */
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
