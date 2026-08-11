import { describe, expect, it, vi } from 'vitest'
import { createWebUnloadPrompt, createWebWindowPort } from '../src/window'

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

describe('createWebUnloadPrompt', () => {
  /** Fire beforeunload at every installed listener and report what the page decided. */
  const unload = (env: ReturnType<typeof fakeWindow>) => {
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown }
    for (const listener of env.listeners) listener(event as unknown as BeforeUnloadEvent)
    return event
  }

  it('installs one listener and removes it on unsubscribe', () => {
    const env = fakeWindow()
    const off = createWebUnloadPrompt(() => false, env)

    expect(env.listeners.size).toBe(1)
    off()
    expect(env.listeners.size).toBe(0)
  })

  it('asks the predicate at unload time rather than being told in advance', () => {
    const env = fakeWindow()
    let dirty = false
    createWebUnloadPrompt(() => dirty, env)

    expect(unload(env).preventDefault).not.toHaveBeenCalled()
    dirty = true
    const prompted = unload(env)
    expect(prompted.preventDefault).toHaveBeenCalled()
    // Both are needed across Chromium versions; the browser picks the wording.
    expect(prompted.returnValue).toBe('')
  })

  it('prompts when the predicate throws, because losing work is worse than an extra dialog', () => {
    const env = fakeWindow()
    createWebUnloadPrompt(() => {
      throw new Error('state unavailable')
    }, env)

    expect(unload(env).preventDefault).toHaveBeenCalled()
  })
})
