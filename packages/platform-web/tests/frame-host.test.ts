import { describe, expect, it } from 'vitest'
import {
  createShellFrameLink,
  FRAME_PROTOCOL,
  type ShellFrameLinkEnv,
  type ShellFrameTarget,
} from '../src/index.js'

const ORIGIN = 'https://shell.example'

interface FakeFrame extends ShellFrameTarget {
  posted: unknown[]
}

function fakeFrame(title = ''): FakeFrame {
  const posted: unknown[] = []
  return {
    posted,
    window: { postMessage: (message) => void posted.push(message) },
    document: { title },
  }
}

interface Harness {
  env: ShellFrameLinkEnv
  deliver(data: unknown, source: unknown, origin?: string): void
  /** Fire every scheduled timeout, oldest first. */
  runTimers(): void
}

function harness(): Harness {
  let handler: ((event: MessageEvent) => void) | null = null
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const env: ShellFrameLinkEnv = {
    origin: ORIGIN,
    addEventListener: (_type, next) => {
      handler = next
    },
    removeEventListener: () => {
      handler = null
    },
    setTimeout: (fn) => {
      const id = nextTimer++
      timers.set(id, fn)
      return id
    },
    clearTimeout: (id) => void timers.delete(id),
  }
  return {
    env,
    deliver: (data, source, origin = ORIGIN) =>
      handler?.({ origin, data, source } as unknown as MessageEvent),
    runTimers: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id)
        fn()
      }
    },
  }
}

/** The last request id the shell posted to this frame. */
function lastRequestId(frame: FakeFrame): string {
  const message = frame.posted.at(-1) as { requestId: string }
  return message.requestId
}

describe('createShellFrameLink', () => {
  it('reads a frame title straight off its document, and nothing when there is none', () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    const frame = fakeFrame('Report.docx')
    link.register('t1', frame)
    expect(link.titleOf('t1')).toBe('Report.docx')
    frame.document = { title: '' }
    expect(link.titleOf('t1')).toBeNull()
    expect(link.titleOf('nope')).toBeNull()
  })

  it('asks a frame whether closing would lose work, and returns its answer', async () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    const frame = fakeFrame()
    link.register('t1', frame)
    const answer = link.wouldLoseWork('t1')
    h.deliver(
      {
        protocol: FRAME_PROTOCOL,
        kind: 'close-check-result',
        frameId: 't1',
        requestId: lastRequestId(frame),
        dirty: true,
      },
      frame.window,
    )
    await expect(answer).resolves.toBe(true)
  })

  it('ignores an answer from a different window claiming the frame id', async () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    const frame = fakeFrame()
    const impostor = fakeFrame()
    link.register('t1', frame)
    const answer = link.wouldLoseWork('t1')
    // Same origin, correct shape, correct id — and a different sender. Accepting
    // it would let one frame talk the shell into discarding another's work.
    h.deliver(
      {
        protocol: FRAME_PROTOCOL,
        kind: 'close-check-result',
        frameId: 't1',
        requestId: lastRequestId(frame),
        dirty: false,
      },
      impostor.window,
    )
    h.runTimers()
    // Fell through to the deadline instead: the frame never announced itself, so
    // silence reads as clean.
    await expect(answer).resolves.toBe(false)
  })

  it('treats silence from a frame that announced itself as dirty', async () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    const frame = fakeFrame()
    link.register('t1', frame)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'ready', frameId: 't1' }, frame.window)
    const answer = link.wouldLoseWork('t1')
    h.runTimers()
    await expect(answer).resolves.toBe(true)
    expect(link.isReady('t1')).toBe(true)
  })

  it('treats silence from a frame that never announced itself as clean', async () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    link.register('t1', fakeFrame())
    const answer = link.wouldLoseWork('t1')
    h.runTimers()
    await expect(answer).resolves.toBe(false)
  })

  it('relays a save request and its outcome', async () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    const frame = fakeFrame()
    link.register('t1', frame)
    const saved = link.requestSave('t1')
    expect(frame.posted.at(-1)).toMatchObject({ kind: 'close-save' })
    h.deliver(
      {
        protocol: FRAME_PROTOCOL,
        kind: 'close-save-result',
        frameId: 't1',
        requestId: lastRequestId(frame),
        ok: true,
      },
      frame.window,
    )
    await expect(saved).resolves.toBe(true)
  })

  it('fails requests for a frame that is not registered, and for one that detaches', async () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    await expect(link.wouldLoseWork('gone')).resolves.toBe(false)
    const frame = fakeFrame()
    link.register('t1', frame)
    const pending = link.requestSave('t1')
    link.register('t1', null)
    await expect(pending).resolves.toBe(false)
  })

  it('keeps a frame ready across a re-register of the same window', () => {
    const h = harness()
    const link = createShellFrameLink(h.env)
    const frame = fakeFrame()
    link.register('t1', frame)
    h.deliver({ protocol: FRAME_PROTOCOL, kind: 'ready', frameId: 't1' }, frame.window)
    link.register('t1', { window: frame.window, document: { title: 'x' } })
    expect(link.isReady('t1')).toBe(true)
    // A different window is a different document and has to announce itself again.
    link.register('t1', fakeFrame())
    expect(link.isReady('t1')).toBe(false)
  })
})
