/**
 * Public surface of the AI BFF.
 *
 * Two kinds of consumer, and the export list is the union of what they need:
 *
 *   - `main.ts`, which reads the environment and starts listening.
 *   - tests and embedders, which want the request handler without a socket.
 *     `createAiBffHandler` is exported for exactly that: it is a plain
 *     `(req, res)` function, so a test can drive it over an ephemeral
 *     `node:http` server and assert on real response bodies.
 *
 * Deliberately *not* exported: anything that returns a credential. There is no
 * such function — `loadAiSettings` is the only thing that ever holds one, and
 * the only view of its result that leaves this process is `toPublicSettings`,
 * which drops the key entirely (see credentials.ts).
 */
export {
  createAiBffHandler,
  createAiBffServer,
  createRedactor,
  DEFAULT_MAX_TOKENS,
  MAX_BODY_BYTES,
} from './server.js'
export type { AiBffOptions } from './server.js'

export { isProviderId, loadAiSettings, resolveProvider, toPublicSettings } from './credentials.js'
export type { Env, ResolvedProvider } from './credentials.js'

export { DEFAULT_HOST, DEFAULT_PORT, loadServerConfig, startAiBff } from './main.js'
export type { AiBffServerConfig, RunningAiBff } from './main.js'
