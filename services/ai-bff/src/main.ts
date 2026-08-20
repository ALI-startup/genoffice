/**
 * Executable entry point: read the environment, bind a socket, log what was configured, and shut
 * down cleanly.
 */
import type { Server } from 'node:http'
import { AI_BFF_BASE_PATH } from '@samugen/platform-web/wire'
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
    host: env.SAMUGEN_AI_BFF_HOST?.trim() || DEFAULT_HOST,
    // Port 0 is meaningful (ask the OS for a free one), so its floor is 0;
    // a zero token ceiling is not, so its floor is 1.
    port: intFromEnv(env.SAMUGEN_AI_BFF_PORT, DEFAULT_PORT, 0),
    maxTokens: intFromEnv(env.SAMUGEN_AI_BFF_MAX_TOKENS, DEFAULT_MAX_TOKENS, 1),
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

/** What the operator needs to see at boot, and nothing they should not. */
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

/** Parse an integer setting, falling back on anything unusable. */
function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const text = raw?.trim()
  if (!text) return fallback
  const value = Number(text)
  return Number.isInteger(value) && value >= min ? value : fallback
}

/** Run as a program only when invoked as one. */
const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[\\/])main\.(?:ts|js|mjs)$/.test(process.argv[1])

if (invokedDirectly) {
  // Reading the environment can now fail (a malformed SAMUGEN_AI_HEADERS_*),
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
