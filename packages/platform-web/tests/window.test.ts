import { describe, expect, it, vi } from 'vitest'
import { createWebWindowPort } from '../src/window'

function fakeWindow() {
  const listeners = new Set<(event: BeforeUnloadEvent) => void>()
  return {
    listeners,
    addEventListener: (_type: 'beforeunload', handler: (event: BeforeUnloadEvent) => void) =>
      void listeners.add(handler),
    removeEventListener: (_type: 'beforeunload', handler: (event: BeforeUnloadEvent) => void) =>
      void listeners.delete(handler),
  }
}

describe('setDirty', () => {
  it('really arms and disarms the browser unload prompt', () => {
    const env = fakeWindow()
    const port = createWebWindowPort(env)

    expect(env.listeners.size).toBe(0)
    port.setDirty(true)
    expect(env.listeners.size).toBe(1)
    port.setDirty(false)
    expect(env.listeners.size).toBe(0)
  })

  it('is idempotent, so repeated mirroring does not stack listeners', () => {
    const env = fakeWindow()
    const port = createWebWindowPort(env)

    port.setDirty(true)
    port.setDirty(true)
    expect(env.listeners.size).toBe(1)
  })

  it('cancels the unload event, which is what triggers the prompt', () => {
    const env = fakeWindow()
    createWebWindowPort(env).setDirty(true)
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown }

    for (const listener of env.listeners) listener(event as unknown as BeforeUnloadEvent)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.returnValue).toBe('')
  })
})

describe('close-save handshake', () => {
  it('is a real subscription: subscribe and unsubscribe both work', () => {
    const port = createWebWindowPort(fakeWindow())
    const off = port.onCloseSaveRequest(() => {
      throw new Error('this host never emits a close-save request')
    })

    // No event is emitted by this host — the browser cannot await a save before
    // unloading — so the handler is never invoked, and unsubscribing is clean.
    expect(() => off()).not.toThrow()
  })

  it('warns instead of silently accepting a reply to a request that was never made', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createWebWindowPort(fakeWindow()).reportCloseSaveResult(true)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('never issues a close-save request'))
    warn.mockRestore()
  })
})
