/**
 * Test harness for the BFF.
 *
 * Two things every test here needs:
 *
 *   - a *real* socket. The security properties being asserted are about bytes
 *     that leave the process, so the tests drive the handler over `node:http`
 *     on an ephemeral port and read actual response bodies rather than
 *     inspecting a mocked `ServerResponse`. A mock could pass while the wire
 *     format leaked.
 *   - recorded provider calls. `streamForProvider` / `chatForProvider` are
 *     injected, so a test can assert exactly which provider id and which
 *     `AiProviderConfig` the server chose — which is how "the browser cannot
 *     choose the endpoint" becomes checkable rather than aspirational.
 */
import { createServer, type Server } from 'node:http'
import type {
  AiChatResponse,
  AiProviderConfig,
  AiProviderId,
  AiSettings,
  chatForProvider,
  streamForProvider,
} from '@genoffice/ai-provider'
import { defaultAiSettings, resolveAiSettings } from '@genoffice/ai-provider'
import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import { createAiBffHandler, type AiBffOptions } from '../src/server.js'

/**
 * A credential long enough to be redacted (the redactor ignores anything under 8
 * characters) and made of nothing but random alphanumerics after the prefix. The
 * no-leak test searches response bodies for every 4-character substring of this
 * value, so it must contain no English word or version-number-like run that
 * could legitimately appear in a model id or an error message and produce a
 * false failure.
 */
export const SECRET_KEY = 'sk_Zq7vK2mP9xR6tW1yB8nC5dF0hJ3gL4sX7uY2'

export interface StreamCall {
  provider: AiProviderId
  config: AiProviderConfig
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
  maxTokens: number
}

export interface ChatCall {
  provider: AiProviderId
  config: AiProviderConfig
  system: string
  user: string
}

export interface StreamBehavior {
  deltas?: string[]
  stopReason?: string
  /** Thrown after the deltas are emitted, to exercise the error path. */
  throws?: unknown
  /** Awaited before anything is emitted, so a test can cancel mid-flight. */
  hold?: Promise<void>
  /** Called with the abort signal, so a test can observe cancellation. */
  onSignal?: (signal: AbortSignal) => void
}

export interface Harness {
  url: string
  streamCalls: StreamCall[]
  chatCalls: ChatCall[]
  /** Every response body this harness has read, for the no-leak sweep. */
  bodies: string[]
  get(path: string): Promise<{ status: number; body: string }>
  post(path: string, body: unknown): Promise<{ status: number; body: string }>
  close(): Promise<void>
}

/** Settings with a credential set for `anthropic`, which is also the active provider. */
export function settingsWithSecret(): AiSettings {
  return resolveAiSettings(
    {
      provider: 'anthropic',
      providers: {
        ...defaultAiSettings().providers,
        anthropic: { apiKey: SECRET_KEY, model: 'claude-test-1' },
      },
    },
    defaultAiSettings(),
  )
}

export async function startHarness(
  options: Partial<AiBffOptions> & { behavior?: StreamBehavior; chatResult?: AiChatResponse } = {},
): Promise<Harness> {
  const streamCalls: StreamCall[] = []
  const chatCalls: ChatCall[] = []
  const bodies: string[] = []
  const behavior = options.behavior ?? {}

  const stream: typeof streamForProvider = async (
    provider,
    config,
    system,
    messages,
    tools,
    maxTokens,
    cb,
  ) => {
    streamCalls.push({ provider, config, system, messages, tools, maxTokens })
    behavior.onSignal?.(cb.signal)
    if (behavior.hold) await behavior.hold
    for (const text of behavior.deltas ?? []) cb.onDelta(text)
    if (behavior.throws !== undefined) throw behavior.throws
    if (behavior.stopReason) cb.onStopReason?.(behavior.stopReason)
  }

  const chat: typeof chatForProvider = async (provider, config, system, user) => {
    chatCalls.push({ provider, config, system, user })
    return options.chatResult ?? { ok: true, content: 'ok' }
  }

  const handler = createAiBffHandler({
    settings: options.settings ?? settingsWithSecret(),
    stream,
    chat,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  })

  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}`

  const record = async (response: Response) => {
    const body = await response.text()
    bodies.push(body)
    return { status: response.status, body }
  }

  return {
    url,
    streamCalls,
    chatCalls,
    bodies,
    get: (path) => fetch(`${url}${path}`).then(record),
    post: (path, body) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }).then(record),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

/** Parse an SSE body into the chunk objects it carried. */
export function sseChunks(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
}
