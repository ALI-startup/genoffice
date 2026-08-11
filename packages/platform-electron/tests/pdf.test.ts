import { describe, expect, it } from 'vitest'
import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import { createPdfAiPort, createPdfLanguagePort, createPdfWindowPort } from '../src/index'

/**
 * Hand-written stand-in for the preload bridge: it records every call and hands
 * back the listener registry, so a test can both assert forwarding and drive a
 * host-originated event. Deliberately not a mock library — the point is that
 * this shape is what apps/pdf's PdfApi actually exposes.
 */
function createFakeBridge() {
  const calls: { method: string; args: unknown[] }[] = []
  const listeners: Record<string, ((...args: any[]) => void)[]> = {
    aiStream: [],
    language: [],
    closeSave: [],
  }
  const subscribe =
    (key: keyof typeof listeners) =>
    (handler: (...args: any[]) => void): (() => void) => {
      listeners[key]!.push(handler)
      return () => {
        const list = listeners[key]!
        list.splice(list.indexOf(handler), 1)
      }
    }
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }

  const settings = { provider: 'openai' } as unknown as AiSettings

  return {
    calls,
    listeners,
    settings,
    bridge: {
      getAiSettings: async (): Promise<AiSettings> => {
        record('getAiSettings')()
        return settings
      },
      aiStream: async (request: AiStreamRequest): Promise<void> => {
        record('aiStream')(request)
      },
      aiStreamCancel: async (requestId: string): Promise<void> => {
        record('aiStreamCancel')(requestId)
      },
      onAiStream: subscribe('aiStream'),
      getLanguage: async (): Promise<Lang> => {
        record('getLanguage')()
        return 'ko'
      },
      onLanguageChanged: subscribe('language'),
      setDirty: record('setDirty'),
      onCloseSaveRequest: subscribe('closeSave'),
      sendCloseSaveResult: record('sendCloseSaveResult'),
    },
  }
}

describe('createPdfAiPort', () => {
  it('forwards getAiSettings, aiStream and aiStreamCancel', async () => {
    const { bridge, calls, settings } = createFakeBridge()
    const port = createPdfAiPort(bridge)

    expect(await port.getAiSettings()).toBe(settings)

    const request = { requestId: 'r1', messages: [] } as unknown as AiStreamRequest
    await port.aiStream(request)
    await port.aiStreamCancel('r1')

    expect(calls).toEqual([
      { method: 'getAiSettings', args: [] },
      { method: 'aiStream', args: [request] },
      { method: 'aiStreamCancel', args: ['r1'] },
    ])
  })

  it('delivers stream chunks and unsubscribes', () => {
    const { bridge, listeners } = createFakeBridge()
    const port = createPdfAiPort(bridge)
    const seen: AiStreamChunk[] = []

    const off = port.onAiStream((chunk) => seen.push(chunk))
    const chunk = { requestId: 'r1', delta: 'hi' } as unknown as AiStreamChunk
    listeners.aiStream.forEach((fn) => fn(chunk))
    expect(seen).toEqual([chunk])

    off()
    expect(listeners.aiStream).toHaveLength(0)
    listeners.aiStream.forEach((fn) => fn(chunk))
    expect(seen).toEqual([chunk])
  })
})

describe('createPdfLanguagePort', () => {
  it('forwards getLanguage', async () => {
    const { bridge, calls } = createFakeBridge()
    expect(await createPdfLanguagePort(bridge).getLanguage()).toBe('ko')
    expect(calls).toEqual([{ method: 'getLanguage', args: [] }])
  })

  it('delivers language changes and unsubscribes', () => {
    const { bridge, listeners } = createFakeBridge()
    const seen: Lang[] = []

    const off = createPdfLanguagePort(bridge).onLanguageChanged((lang) => seen.push(lang))
    listeners.language.forEach((fn) => fn('ja'))
    expect(seen).toEqual(['ja'])

    off()
    expect(listeners.language).toHaveLength(0)
    listeners.language.forEach((fn) => fn('en'))
    expect(seen).toEqual(['ja'])
  })
})

describe('createPdfWindowPort', () => {
  it('forwards setDirty', () => {
    const { bridge, calls } = createFakeBridge()
    const port = createPdfWindowPort(bridge)
    port.setDirty(true)
    port.setDirty(false)
    expect(calls).toEqual([
      { method: 'setDirty', args: [true] },
      { method: 'setDirty', args: [false] },
    ])
  })

  it('maps reportCloseSaveResult onto the bridge sendCloseSaveResult', () => {
    const { bridge, calls } = createFakeBridge()
    createPdfWindowPort(bridge).reportCloseSaveResult(true)
    expect(calls).toEqual([{ method: 'sendCloseSaveResult', args: [true] }])
  })

  it('delivers close-save requests and unsubscribes', () => {
    const { bridge, listeners } = createFakeBridge()
    let asked = 0

    const off = createPdfWindowPort(bridge).onCloseSaveRequest(() => (asked += 1))
    listeners.closeSave.forEach((fn) => fn())
    expect(asked).toBe(1)

    off()
    expect(listeners.closeSave).toHaveLength(0)
    listeners.closeSave.forEach((fn) => fn())
    expect(asked).toBe(1)
  })
})
