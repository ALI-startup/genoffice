/** The executable entry: environment → config, and a real bind. */
import { describe, expect, it } from 'vitest'
import { AI_BFF_ROUTES } from '@samugen/platform-web/wire'
import { DEFAULT_HOST, DEFAULT_PORT, loadServerConfig, startAiBff } from '../src/main.js'
import { DEFAULT_MAX_TOKENS } from '../src/server.js'
import { SECRET_KEY } from './fakes.js'

describe('loadServerConfig', () => {
  it('defaults to loopback so the credential holder is not exposed by accident', () => {
    expect(loadServerConfig({})).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      maxTokens: DEFAULT_MAX_TOKENS,
    })
    expect(DEFAULT_HOST).toBe('127.0.0.1')
  })

  it('honours explicit host, port and token ceiling', () => {
    expect(
      loadServerConfig({
        SAMUGEN_AI_BFF_HOST: '0.0.0.0',
        SAMUGEN_AI_BFF_PORT: '9999',
        SAMUGEN_AI_BFF_MAX_TOKENS: '2048',
      }),
    ).toEqual({ host: '0.0.0.0', port: 9999, maxTokens: 2048 })
  })

  it('accepts port 0, which asks the OS for a free port', () => {
    expect(loadServerConfig({ SAMUGEN_AI_BFF_PORT: '0' }).port).toBe(0)
  })

  it('ignores unusable values instead of binding somewhere unintended', () => {
    for (const port of ['', '  ', 'http', '-1', '80.5']) {
      expect(loadServerConfig({ SAMUGEN_AI_BFF_PORT: port }).port).toBe(DEFAULT_PORT)
    }
    expect(loadServerConfig({ SAMUGEN_AI_BFF_HOST: '   ' }).host).toBe(DEFAULT_HOST)
  })
})

describe('startAiBff', () => {
  it('binds, serves the settings route, and closes', async () => {
    const running = await startAiBff({
      SAMUGEN_AI_BFF_PORT: '0',
      SAMUGEN_AI_PROVIDER: 'anthropic',
      SAMUGEN_AI_KEY_ANTHROPIC: SECRET_KEY,
      SAMUGEN_AI_MODEL_ANTHROPIC: 'claude-test-1',
    })
    try {
      expect(running.port).toBeGreaterThan(0)
      const health = await fetch(`http://127.0.0.1:${running.port}/health`)
      expect(health.status).toBe(200)

      const response = await fetch(`http://127.0.0.1:${running.port}${AI_BFF_ROUTES.settings}`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(JSON.parse(body)).toMatchObject({
        active: { providerId: 'anthropic', model: 'claude-test-1' },
      })
      // The env-configured key must not survive the trip through a live socket.
      expect(body).not.toContain(SECRET_KEY)
      expect(body).not.toContain(SECRET_KEY.slice(-4))
    } finally {
      await running.close()
    }
  })

  it('rejects rather than hanging when the port is already taken', async () => {
    const first = await startAiBff({ SAMUGEN_AI_BFF_PORT: '0' })
    try {
      await expect(startAiBff({ SAMUGEN_AI_BFF_PORT: String(first.port) })).rejects.toThrowError()
    } finally {
      await first.close()
    }
  })
})
