/**
 * Executable entry point: read the environment, bind a socket, report whether
 * the converter is actually usable, and shut down cleanly.
 *
 * Split from server.ts for the reason the AI BFF splits the same way — that file
 * is a pure handler with its settings injected, and this one owns the two impure
 * things, `process.env` and `listen`.
 *
 * Environment:
 *
 *   SAMUGEN_HWP_CONVERT_HOST     bind address (default 127.0.0.1)
 *   SAMUGEN_HWP_CONVERT_PORT     port (default 8789); 0 asks the OS for a free one
 *   SAMUGEN_HWP_CONVERT_TIMEOUT  ceiling on one conversion, ms (default 120000)
 *   SAMUGEN_HWP2HWPX_JAR         converter JAR (default: the vendored one)
 *   SAMUGEN_JAVA_BIN             `java` executable (default: `java` on the PATH)
 *
 * Loopback by default, like the BFF: this process runs a subprocess over bytes
 * it is handed, so being reachable from off the machine is an explicit opt-in.
 *
 * A missing JVM is logged at startup and does not stop the service. It still
 * answers `/health` with `converter: false`, which is how the browser learns not
 * to offer `.hwp` in a file dialog — the alternative, refusing to boot, takes
 * the whole stack down over a format that most documents are not in.
 */
import type { Server } from 'node:http'
import { CONVERT_BASE_PATH } from '@samugen/platform-web/convert-wire'
import { converterAvailable, DEFAULT_TIMEOUT_MS, VENDORED_JAR } from './convert.js'
import { createHwpConvertServer } from './server.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8789

export type Env = Record<string, string | undefined>

export interface HwpConvertConfig {
  host: string
  port: number
  timeoutMs: number
  jar: string
  javaBin: string
}

export interface RunningHwpConvert {
  server: Server
  /** The port actually bound, which differs from the requested one when it was 0. */
  port: number
  /** Whether a conversion would work right now. */
  converter: boolean
  close(): Promise<void>
}

export function loadConvertConfig(env: Env = process.env): HwpConvertConfig {
  return {
    host: env.SAMUGEN_HWP_CONVERT_HOST?.trim() || DEFAULT_HOST,
    // Port 0 is meaningful (ask the OS for a free one), so its floor is 0; a
    // zero timeout is not, so its floor is 1.
    port: intFromEnv(env.SAMUGEN_HWP_CONVERT_PORT, DEFAULT_PORT, 0),
    timeoutMs: intFromEnv(env.SAMUGEN_HWP_CONVERT_TIMEOUT, DEFAULT_TIMEOUT_MS, 1),
    jar: env.SAMUGEN_HWP2HWPX_JAR?.trim() || decodeURIComponent(VENDORED_JAR.pathname),
    javaBin: env.SAMUGEN_JAVA_BIN?.trim() || 'java',
  }
}

export async function startHwpConvert(env: Env = process.env): Promise<RunningHwpConvert> {
  const config = loadConvertConfig(env)
  const server = createHwpConvertServer({
    jar: config.jar,
    javaBin: config.javaBin,
    timeoutMs: config.timeoutMs,
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  const converter = await converterAvailable({ jar: config.jar, javaBin: config.javaBin })
  return {
    server,
    port,
    converter,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const value = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(value) && value >= min ? value : fallback
}

/** `tsx src/main.ts` runs this; importing the module does not. */
async function run(): Promise<void> {
  const running = await startHwpConvert()
  const config = loadConvertConfig()
  console.log(
    `[hwp-convert] listening on http://${config.host}:${running.port}${CONVERT_BASE_PATH}`,
  )
  if (running.converter) {
    console.log(`[hwp-convert] converter ready (${config.jar})`)
  } else {
    console.warn(
      `[hwp-convert] converter UNAVAILABLE — no usable "${config.javaBin}" or missing ${config.jar}. ` +
        '.hwp files will be rejected; .hwpx is unaffected.',
    )
  }
  const stop = (signal: string) => {
    console.log(`[hwp-convert] ${signal} — closing`)
    void running.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void run()
}
