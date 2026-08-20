import { describe, expect, it, vi } from 'vitest'
import {
  createFrameChildLink,
  FRAME_PROTOCOL,
  parseFrameToShell,
  parseShellToFrame,
  frameIdFromLocation,
  type FrameChildEnv,
} from '../src/index.js'

const ORIGIN = 'https://shell.example'

/** The frame protocol's validators and the frame-side client. */
describe('parseFrameToShell', () => {
  const ready = { protocol: FRAME_PROTOCOL, kind: 'ready', frameId: 't1' }

  it('accepts a well-formed message from the same origin', () => {
    expect(parseFrameToShell({ origin: ORIGIN, data: ready }, ORIGIN)).toEqual(ready)
  })

  it('rejects a message from another origin', () => {
    expect(parseFrameToShell({ origin: 'https://evil.example', data: ready }, ORIGIN)).toBeNull()
  })

  it('rejects an opaque origin even when the page itself is opaque', () => {
    expect(parseFrameToShell({ origin: 'null', data: ready }, 'null')).toBeNull()
  })

  it('rejects anything without the protocol tag', () => {
    for (const data of [
      null,
      undefined,
      'ready',
      42,
      [],
      { kind: 'ready', frameId: 't1' },
      { protocol: 'other', kind: 'ready', frameId: 't1' },
    ]) {
      expect(parseFrameToShell({ origin: ORIGIN, data }, ORIGIN)).toBeNull()
    }
  })

  it('rejects an unknown kind', () => {
    const data = { protocol: FRAME_PROTOCOL, kind: 'shutdown', frameId: 't1' }
    expect(parseFrameToShell({ origin: ORIGIN, data }, ORIGIN)).toBeNull()
  })

  it('rejects a message with a missing or mistyped field', () => {
    const base = { protocol: FRAME_PROTOCOL, kind: 'close-check-result', frameId: 't1' }
    for (const data of [
      { ...base },
      { ...base, requestId: 'r1' },
      { ...base, requestId: 'r1', dirty: 'yes' },
      { ...base, requestId: '', dirty: true },
      { ...base, frameId: 7, requestId: 'r1', dirty: true },
    ]) {
      expect(parseFrameToShell({ origin: ORIGIN, data }, ORIGIN)).toBeNull()
    }
    expect(
      parseFrameToShell(
        { origin: ORIGIN, data: { ...base, requestId: 'r1', dirty: true } },
        ORIGIN,
      ),
    ).toEqual({ ...base, requestId: 'r1', dirty: true })
  })
})

describe('parseShellToFrame', () => {
  it('accepts the two request kinds and nothing else', () => {
    const check = { protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r1' }
    const save = { protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: 'r2' }
    expect(parseShellToFrame({ origin: ORIGIN, data: check }, ORIGIN)).toEqual(check)
    expect(parseShellToFrame({ origin: ORIGIN, data: save }, ORIGIN)).toEqual(save)
    expect(
      parseShellToFrame(
        { origin: ORIGIN, data: { protocol: FRAME_PROTOCOL, kind: 'ready', requestId: 'r3' } },
        ORIGIN,
      ),
    ).toBeNull()
  })

  it('rejects a request with no id', () => {
    const data = { protocol: FRAME_PROTOCOL, kind: 'close-check' }
    expect(parseShellToFrame({ origin: ORIGIN, data }, ORIGIN)).toBeNull()
  })
})

describe('frameIdFromLocation', () => {
  it('reads the shell frame id, and nothing when there is none', () => {
    expect(frameIdFromLocation('?shellFrame=t3')).toBe('t3')
    expect(frameIdFromLocation('?other=1')).toBeNull()
    expect(frameIdFromLocation('?shellFrame=')).toBeNull()
    expect(frameIdFromLocation('')).toBeNull()
  })
})

interface Harness {
  env: FrameChildEnv
  posted: unknown[]
  deliver(data: unknown, origin?: string): void
}

function harness(frameId: string | null, embedded = true): Harness {
  const posted: unknown[] = []
  let handler: ((event: MessageEvent) => void) | null = null
  const env: FrameChildEnv = {
    origin: ORIGIN,
    frameId,
    parent: embedded ? { postMessage: (message) => void posted.push(message) } : null,
    addEventListener: (_type, next) => {
      handler = next
    },
    removeEventListener: () => {
      handler = null
    },
  }
  return {
    env,
    posted,
    deliver: (data, origin = ORIGIN) => handler?.({ origin, data } as MessageEvent),
  }
}

describe('createFrameChildLink', () => {
  it('is absent when the page is not shell-hosted', () => {
    expect(createFrameChildLink(harness(null).env)).toBeNull()
    expect(createFrameChildLink(harness('t1', false).env)).toBeNull()
  })

  it('announces itself as soon as it is installed', () => {
    const h = harness('t1')
    createFrameChildLink(h.env)
    expect(h.posted).toEqual([{ protocol: FRAME_PROTOCOL, kind: 'ready', frameId: 't1' }])
  })

  it('answers a close check from the registered predicate', () => {
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    link.onCloseCheck(() => true)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r1' })
    expect(h.posted.at(-1)).toEqual({
      protocol: FRAME_PROTOCOL,
      kind: 'close-check-result',
      frameId: 't1',
      requestId: 'r1',
      dirty: true,
    })
  })

  it('reports dirty when the predicate throws or is missing', () => {
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r1' })
    expect(h.posted.at(-1)).toMatchObject({ dirty: true })
    link.onCloseCheck(() => {
      throw new Error('state unavailable')
    })
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r2' })
    expect(h.posted.at(-1)).toMatchObject({ dirty: true })
  })

  it('ignores a message from another origin', () => {
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    link.onCloseCheck(() => false)
    h.deliver(
      { protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r1' },
      'https://evil.example',
    )
    expect(h.posted).toHaveLength(1) // the `ready` announcement only
  })

  it('runs the save handler and relays its outcome once', () => {
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    link.onCloseSave(() => {
      /* async in the real app; the reply comes through reportCloseSave */
    })
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: 'r9' })
    expect(h.posted).toHaveLength(1)
    link.reportCloseSave(true)
    expect(h.posted.at(-1)).toEqual({
      protocol: FRAME_PROTOCOL,
      kind: 'close-save-result',
      frameId: 't1',
      requestId: 'r9',
      ok: true,
    })
    // A second report has no request to answer and is dropped.
    link.reportCloseSave(true)
    expect(h.posted).toHaveLength(2)
  })

  it('fails a save request immediately when nothing is registered to save', () => {
    const h = harness('t1')
    createFrameChildLink(h.env)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: 'r9' })
    expect(h.posted.at(-1)).toMatchObject({ kind: 'close-save-result', ok: false })
  })

  it('fails the request when the save handler throws', () => {
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    link.onCloseSave(() => {
      throw new Error('boom')
    })
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: 'r9' })
    expect(h.posted.at(-1)).toMatchObject({ kind: 'close-save-result', ok: false })
  })

  it('stops listening after dispose', () => {
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    link.onCloseCheck(() => false)
    link.dispose()
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r1' })
    expect(h.posted).toHaveLength(1)
  })
})

describe('createWebWindowPort with a frame link', () => {
  it('answers the shell close check from the same flag beforeunload uses', async () => {
    const { createWebWindowPort } = await import('../src/index.js')
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    const port = createWebWindowPort(
      { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      link,
    )
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r1' })
    expect(h.posted.at(-1)).toMatchObject({ dirty: false })
    port.setDirty(true)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-check', requestId: 'r2' })
    expect(h.posted.at(-1)).toMatchObject({ dirty: true })
  })

  it('drives a real close-save request into its subscribers', async () => {
    const { createWebWindowPort } = await import('../src/index.js')
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    const port = createWebWindowPort(
      { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      link,
    )
    const saved = vi.fn(() => port.reportCloseSaveResult(true))
    port.onCloseSaveRequest(saved)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: 'r5' })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(h.posted.at(-1)).toMatchObject({ kind: 'close-save-result', requestId: 'r5', ok: true })
  })

  it('answers a close-save request with false when nobody subscribed', async () => {
    const { createWebWindowPort } = await import('../src/index.js')
    const h = harness('t1')
    const link = createFrameChildLink(h.env)!
    createWebWindowPort({ addEventListener: vi.fn(), removeEventListener: vi.fn() }, link)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'close-save', requestId: 'r5' })
    expect(h.posted.at(-1)).toMatchObject({ kind: 'close-save-result', ok: false })
  })
})
