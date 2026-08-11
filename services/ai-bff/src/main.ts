/**
 * Executable entry point: read the environment, bind a socket, log what was
 * configured, and shut down cleanly.
 *
 * Split from server.ts on purpose. server.ts is a pure request handler with its
 * settings injected, which is what makes it testable without a socket; this file
 * owns the two impure things — `process.env` and `listen` — and nothing else.
 *
 * Environment (credentials themselves are documented in credentials.ts):
 *
 *   GENOFFICE_AI_BFF_HOST        bind address (default 127.0.0.1)
 *   GENOFFICE_AI_BFF_PORT        port (default 8788); 0 asks the OS for a free one
 *   GENOFFICE_AI_BFF_MAX_TOKENS  output token ceiling per turn (default 8192)
 *
 * The default bind address is loopback, not `0.0.0.0`. This process holds the
 * provider credentials and applies no authentication of its own — it trusts
 * whatever reaches it — so it must not be reachable from off the machine by
 * accident. Exposing it is an explicit opt-in via GENOFFICE_AI_BFF_HOST.
 */
import type { Server } from 'node:http'
import { AI_BFF_BASE_PATH } from '@genoffice/platform-web/wire'
import { loadAiSettings, toPublicSettings, type Env } from './credentials.js'
import { createAiBffServer, DEFAULT_MAX_TOKENS } from './server.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8788

export interface AiBffServerConfig {
  host: string
  port: number
  maxTokens: number
}

export interface RunningAiBff {
  server: Server
  /** The port actually bound, which differs from the requested one when it was 0. */
  port: number
  close(): Promise<void>
}

export function loadServerConfig(env: Env = process.env): AiBffServerConfig {
  return {
    host: env.GENOFFICE_AI_BFF_HOST?.trim() || DEFAULT_HOST,
    // Port 0 is meaningful (ask the OS for a free one), so its floor is 0;
    // a zero token ceiling is not, so its floor is 1.
    port: intFromEnv(env.GENOFFICE_AI_BFF_PORT, DEFAULT_PORT, 0),
    maxTokens: intFromEnv(env.GENOFFICE_AI_BFF_MAX_TOKENS, DEFAULT_MAX_TOKENS, 1),
  }
}

/**
 * Start the service. Resolves once the socket is bound, so a caller (or a test)
 * knows the port before it issues a request.
 */
export async function startAiBff(env: Env = process.env): Promise<RunningAiBff> {
  const config = loadServerConfig(env)
  const settings = loadAiSettings(env)
  const server = createAiBffServer({ settings, maxTokens: config.maxTokens })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

/**
 * What the operator needs to see at boot, and nothing they should not.
 *
 * Per provider this prints the id, the model and whether a credential is
 * present — all of it read from `toPublicSettings`, the same redacted view the
 * HTTP surface serves. Logging is therefore incapable of printing a key, rather
 * than merely avoiding it.
 *
 * Extra headers are the one thing read from the settings directly, because the
 * public view has no field for them. Only `Object.keys` is touched: the names
 * confirm a tracking header actually loaded, and no code path here can reach a
 * header *value*.
 */
function describe(settings: ReturnType<typeof loadAiSettings>): string {
  const view = toPublicSettings(settings)
  const rows = Object.values(view.providers).map((entry) => {
    const headerNames = Object.keys(settings.providers[entry.providerId]?.headers ?? {})
    return (
      `${entry.providerId} (${entry.model || 'no model'}, ` +
      `${entry.credentialConfigured ? 'credential set' : 'NO credential'}` +
      `${headerNames.length > 0 ? `, headers: ${headerNames.join(' ')}` : ''})`
    )
  })
  const active = `active: ${view.active.providerId} (${view.active.model || 'no model'})`
  return rows.length > 0
    ? `${active}; configured: ${rows.join(', ')}`
    : `${active}; configured: none`
}

/**
 * Parse an integer setting, falling back on anything unusable.
 *
 * `Number('')` and `Number('  ')` are 0, not NaN, so an unset-but-present env var
 * would otherwise bind port 0 instead of the default — hence the explicit blank
 * check before the numeric one.
 */
function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const text = raw?.trim()
  if (!text) return fallback
  const value = Number(text)
  return Number.isInteger(value) && value >= min ? value : fallback
}

/**
 * Run as a program only when invoked as one. Guarding on argv keeps `import`ing
 * this module (tests, an embedder) free of side effects.
 */
const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[\\/])main\.(?:ts|js|mjs)$/.test(process.argv[1])

if (invokedDirectly) {
  // Reading the environment can now fail (a malformed GENOFFICE_AI_HEADERS_*),
  // and it happens before `startAiBff` has a promise to reject — so it needs the
  // same one-line diagnosis as any other startup failure rather than a stack trace.
  let config: AiBffServerConfig
  let settings: ReturnType<typeof loadAiSettings>
  try {
    config = loadServerConfig()
    settings = loadAiSettings()
  } catch (error: unknown) {
    console.error('[ai-bff] failed to start:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
  startAiBff().then(
    ({ port, close }) => {
      console.info(`[ai-bff] listening on http://${config.host}:${port}${AI_BFF_BASE_PATH}`)
      console.info(`[ai-bff] ${describe(settings)}`)
      // A dev run is stopped with Ctrl-C; drain in-flight streams rather than
      // dropping sockets, and exit non-zero only on a real close failure.
      const shutdown = (signal: string) => {
        console.info(`[ai-bff] ${signal} received, closing`)
        close().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error('[ai-bff] close failed:', error)
            process.exit(1)
          },
        )
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    },
    (error: unknown) => {
      console.error('[ai-bff] failed to start:', error)
      process.exit(1)
    },
  )
}
