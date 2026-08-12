/**
 * The browser host adapter (src/renderer/platform-web.ts).
 *
 * @genoffice/platform-web covers the document store, the attachments port and the
 * unload guard, so what is left to check here is the glue that turns those into
 * docs' own ports: which store call each channel makes, how a dismissed dialog
 * becomes a cancel rather than a failure, the gesture rule that makes `saveNew`
 * possible at all, and — the part most worth pinning down — that the close-check
 * pull really works over `beforeunload` while the members that cannot work do not
 * pretend to.
 *
 * The store is faked at its public surface rather than mocked per method, so the
 * assertions are about the adapter's choices and not about a call graph.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebDocumentStore } from '@genoffice/platform-web'
import type { FilePickers, WebFileHandle } from '@genoffice/platform-web'
import { createWebDocsFilePort, createWebDocsWindowPort } from '../src/renderer/platform-web'

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

interface FakeStore {
  store: WebDocumentStore
  files: Map<string, Uint8Array>
  /** Per-ref last-modified stamp; a test bumps it to model another program's write. */
  stamps: Map<string, number>
  writes: Array<{ ref: string; size: number }>
  saveAsCalls: string[]
  /** How many times the adapter re-read a file to hash it (the expensive branch). */
  reads: string[]
}

function fakeStore(
  overrides: Partial<Record<keyof WebDocumentStore, unknown>> = {},
  initial: Array<[string, Uint8Array]> = [['doc-1', DOCX_BYTES]],
): FakeStore {
  const files = new Map(initial)
  const stamps = new Map<string, number>([...files.keys()].map((ref) => [ref, 1_000]))
  const writes: FakeStore['writes'] = []
  const saveAsCalls: string[] = []
  const reads: string[] = []
  const base = {
    open: () => Promise.resolve(null),
    reopen: (ref: string) => Promise.resolve({ ref, name: 'reopened.docx' }),
    recent: () => Promise.resolve([]),
    read: (ref: string) => {
      const bytes = files.get(ref)
      if (!bytes) throw new Error(`no such ref: ${ref}`)
      reads.push(ref)
      return Promise.resolve(bytes)
    },
    stat: (ref: string) => {
      const bytes = files.get(ref)
      if (!bytes) return Promise.reject(new Error(`no such ref: ${ref}`))
      return Promise.resolve({ lastModified: stamps.get(ref) ?? 0, size: bytes.byteLength })
    },
    write: (ref: string, bytes: Uint8Array) => {
      files.set(ref, bytes)
      // A real write moves the file's stamp; the adapter must re-baseline from its
      // own write or the next save would flag it as somebody else's.
      stamps.set(ref, (stamps.get(ref) ?? 0) + 1_000)
      writes.push({ ref, size: bytes.byteLength })
      return Promise.resolve()
    },
    saveAsDocument: (suggestedName: string, bytes: Uint8Array) => {
      saveAsCalls.push(suggestedName)
      files.set('doc-2', bytes)
      stamps.set('doc-2', 5_000)
      return Promise.resolve({ ref: 'doc-2', name: suggestedName })
    },
    ...overrides,
  } as Record<string, unknown>
  return { store: base as unknown as WebDocumentStore, files, stamps, writes, saveAsCalls, reads }
}

/** Model another program writing the file while it is open here. */
function externalWrite(fake: FakeStore, ref: string, bytes: Uint8Array): void {
  fake.files.set(ref, bytes)
  fake.stamps.set(ref, (fake.stamps.get(ref) ?? 0) + 7_000)
}

/** Pickers that hand back one image handle, for pickImage. */
function fakePickers(handle?: WebFileHandle | Error): FilePickers {
  return {
    openFile: () =>
      handle instanceof Error || handle === undefined
        ? Promise.reject(handle ?? new Error('nothing queued'))
        : Promise.resolve(handle),
    saveFile: () => Promise.reject(new Error('not used')),
    directory: () => Promise.reject(new Error('not used')),
  }
}

function imageHandle(name: string, bytes: Uint8Array): WebFileHandle {
  return {
    kind: 'file',
    name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFile: async () => ({
      name,
      size: bytes.byteLength,
      lastModified: 1_000,
      arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer,
    }),
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  }
}

const granted = () => true
const overwriteYes = () => true
const withPort = (
  store: WebDocumentStore,
  activation = granted,
  pickers = fakePickers(),
  confirmOverwrite = overwriteYes,
) => createWebDocsFilePort(store, pickers, activation, confirmOverwrite)

describe('boot', () => {
  it('has nothing pending, which is what makes a fresh tab land on a blank document', async () => {
    const { store } = fakeStore()
    await expect(withPort(store).consumePending()).resolves.toBeNull()
  })

  it('reports a new blank document, because that is what a fresh browser tab is', async () => {
    const { store } = fakeStore()
    await expect(withPort(store).consumeNewBlank()).resolves.toBe(true)
  })

  it('exposes the host-driven document channels as subscriptions with no emissions', () => {
    const port = withPort(fakeStore().store)
    // No OS file association and no shell rename list behind them; subscribing and
    // unsubscribing must still be clean, and the handler must never fire.
    const offOpen = port.onOpenDocument(() => {
      throw new Error('this host never opens a document on its own')
    })
    const offRenamed = port.onDocumentRenamed(() => {
      throw new Error('this host never renames the open document')
    })
    expect(() => {
      offOpen()
      offRenamed()
    }).not.toThrow()
  })
})

describe('openDocument', () => {
  it('reads the picked file and hashes it as opened', async () => {
    const { store } = fakeStore({
      open: () => Promise.resolve({ ref: 'doc-1', name: 'report.docx' }),
    })

    const outcome = await withPort(store).openDocument()

    // Always a document, never an import: this host's picker offers .docx alone.
    expect(outcome?.kind).toBe('document')
    const opened = outcome?.kind === 'document' ? outcome.document : null
    expect(opened?.ref).toBe('doc-1')
    expect(opened?.name).toBe('report.docx')
    expect(new Uint8Array(opened!.data)).toEqual(DOCX_BYTES)
    // A real sha256 rather than a blank placeholder: it is what the desktop host's
    // original-file archive is keyed by, so a wrong value would be a lie in state.
    expect(opened?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(opened?.hash).toBe(await sha256Hex(DOCX_BYTES))
  })

  it('reports a dismissed dialog as null', async () => {
    const { store } = fakeStore()
    await expect(withPort(store).openDocument()).resolves.toBeNull()
  })
})

describe('openDocumentByRef', () => {
  it('reopens a persisted handle, which is what makes the recent list work after a reload', async () => {
    const { store } = fakeStore()

    const opened = await withPort(store).openDocumentByRef('doc-1')

    expect(opened).toMatchObject({
      kind: 'document',
      document: { ref: 'doc-1', name: 'reopened.docx' },
    })
  })

  it('lets a declined permission prompt surface instead of yielding an empty document', async () => {
    const { store } = fakeStore({
      reopen: () => Promise.reject(new Error('Permission to edit "report.docx" was not granted')),
    })

    await expect(withPort(store).openDocumentByRef('doc-1')).rejects.toThrow('not granted')
  })
})

describe('save', () => {
  it('writes in place, through the handle the document was opened from', async () => {
    const { store, files, writes } = fakeStore()

    const result = await withPort(store).save('doc-1', new Uint8Array([7, 7]).buffer)

    expect(result).toEqual({ ok: true })
    // Save-in-place, not a download: the same ref now holds the new bytes.
    expect([...files.get('doc-1')!]).toEqual([7, 7])
    expect(writes).toEqual([{ ref: 'doc-1', size: 2 }])
  })

  it('turns a write failure into { ok: false, error } instead of throwing at the renderer', async () => {
    const { store } = fakeStore({
      write: () => Promise.reject(new Error('the file was moved')),
    })

    await expect(withPort(store).save('doc-1', new Uint8Array([1]).buffer)).resolves.toEqual({
      ok: false,
      error: 'the file was moved',
    })
  })
})

describe('save: the external-modification guard', () => {
  it('does not reread the file when last-modified and size still match', async () => {
    const fake = fakeStore()
    const port = withPort(fake.store)
    await port.openDocumentByRef('doc-1')
    const readsAfterOpen = fake.reads.length

    await expect(port.save('doc-1', new Uint8Array([9, 9]).buffer)).resolves.toEqual({ ok: true })

    // The shared predicate's performance property, preserved: the hash read only
    // runs once the stamp already disagrees, so an ordinary save stats once and
    // reads nothing.
    expect(fake.reads.length).toBe(readsAfterOpen)
  })

  it("refuses an autosave over another program's write, silently, and writes nothing", async () => {
    const fake = fakeStore()
    const port = withPort(fake.store, granted, fakePickers(), () => {
      throw new Error('an autosave must never prompt')
    })
    await port.openDocumentByRef('doc-1')
    externalWrite(fake, 'doc-1', new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5]))
    fake.writes.length = 0

    // Same two-branch behaviour as the Electron host: no prompt, `external-modified`
    // so the renderer stays dirty and shows nothing, and the next manual save asks.
    await expect(port.save('doc-1', new Uint8Array([9]).buffer, true)).resolves.toEqual({
      ok: false,
      reason: 'external-modified',
    })
    expect(fake.writes).toEqual([])
    expect([...fake.files.get('doc-1')!]).toEqual([5, 5, 5, 5, 5, 5, 5, 5])
  })

  it('asks on a manual save and writes nothing when the user declines', async () => {
    const fake = fakeStore()
    const confirm = vi.fn(() => false)
    const port = withPort(fake.store, granted, fakePickers(), confirm)
    await port.openDocumentByRef('doc-1')
    externalWrite(fake, 'doc-1', new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5]))
    fake.writes.length = 0

    await expect(port.save('doc-1', new Uint8Array([9]).buffer)).resolves.toEqual({
      ok: false,
      reason: 'external-modified',
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fake.writes).toEqual([])
  })

  it('overwrites on a manual save when the user says so', async () => {
    const fake = fakeStore()
    const port = withPort(fake.store, granted, fakePickers(), () => true)
    await port.openDocumentByRef('doc-1')
    externalWrite(fake, 'doc-1', new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5]))

    await expect(port.save('doc-1', new Uint8Array([9]).buffer)).resolves.toEqual({ ok: true })
    expect([...fake.files.get('doc-1')!]).toEqual([9])
  })

  it('re-baselines from its own write, so a second save is not flagged as a conflict', async () => {
    const fake = fakeStore()
    const confirm = vi.fn(() => true)
    const port = withPort(fake.store, granted, fakePickers(), confirm)
    await port.openDocumentByRef('doc-1')

    await port.save('doc-1', new Uint8Array([9]).buffer)
    await port.save('doc-1', new Uint8Array([8]).buffer)

    // The fake moves the stamp on every write, exactly as a filesystem does; the
    // adapter must record the new state or it would prompt about itself.
    expect(confirm).not.toHaveBeenCalled()
    expect([...fake.files.get('doc-1')!]).toEqual([8])
  })

  it('does not flag an untracked ref, so a save into a never-read document proceeds', async () => {
    const fake = fakeStore()
    const confirm = vi.fn(() => false)

    // No open/read first: nothing recorded, so there is no baseline to conflict with.
    await expect(
      withPort(fake.store, granted, fakePickers(), confirm).save(
        'doc-1',
        new Uint8Array([9]).buffer,
      ),
    ).resolves.toEqual({ ok: true })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('baselines a Save As destination too, so the next in-place save is guarded', async () => {
    const fake = fakeStore()
    const confirm = vi.fn(() => false)
    const port = withPort(fake.store, granted, fakePickers(), confirm)

    const saved = await port.saveAs('report.docx', new Uint8Array([1]).buffer)
    externalWrite(fake, saved.ref!, new Uint8Array([5, 5, 5, 5]))

    await expect(port.save(saved.ref!, new Uint8Array([9]).buffer)).resolves.toEqual({
      ok: false,
      reason: 'external-modified',
    })
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})

describe('saveAs', () => {
  it('adopts the destination and reports its ref and name', async () => {
    const { store, saveAsCalls } = fakeStore()

    const result = await withPort(store).saveAs('report.docx', new Uint8Array([1]).buffer)

    expect(result).toEqual({ ok: true, ref: 'doc-2', name: 'report.docx' })
    expect(saveAsCalls).toEqual(['report.docx'])
  })

  it('adds the extension a browser dialog would otherwise take literally', async () => {
    const { store, saveAsCalls } = fakeStore()

    // The renderer derives a default name from the first heading, with no suffix.
    await withPort(store).saveAs('Quarterly Review', new Uint8Array([1]).buffer)

    expect(saveAsCalls).toEqual(['Quarterly Review.docx'])
  })

  it('reports a dismissed dialog as a cancel: not ok, and no error to show', async () => {
    const { store } = fakeStore({ saveAsDocument: () => Promise.resolve(null) })

    await expect(withPort(store).saveAs('a.docx', new Uint8Array([1]).buffer)).resolves.toEqual({
      ok: false,
    })
  })
})

describe('saveNew', () => {
  it('falls back to the Save As dialog, because a browser has no silent default folder', async () => {
    const { store, saveAsCalls } = fakeStore()

    const result = await withPort(store).saveNew('Untitled.docx', new Uint8Array([1]).buffer)

    expect(result).toEqual({ ok: true, ref: 'doc-2', name: 'Untitled.docx' })
    expect(saveAsCalls).toEqual(['Untitled.docx'])
  })

  it('reports a distinguishable outcome with no user gesture, not a bare cancel', async () => {
    const { store, saveAsCalls } = fakeStore()

    const result = await withPort(store, () => false).saveNew(
      'Untitled.docx',
      new Uint8Array([1]).buffer,
    )

    // The `reason` is the whole point: a bare `{ ok: false }` is indistinguishable
    // from a dismissed dialog, so the renderer would report nothing and the user
    // would believe a never-saved document was being autosaved when it was not.
    // With the reason, file-actions shows its own status instead of either lying or
    // flashing "save failed" every 30 seconds. And no error, because nothing failed.
    expect(result).toEqual({ ok: false, reason: 'needs-user-gesture' })
    expect(result.error).toBeUndefined()
    expect(saveAsCalls).toEqual([])
  })
})

describe('writeRecoveryCopy', () => {
  it('reports that no copy was made, rather than writing bytes nothing would read', async () => {
    const { store, writes } = fakeStore()

    await expect(
      withPort(store).writeRecoveryCopy('doc-1', new Uint8Array([1]).buffer),
    ).resolves.toEqual({ ok: false })
    expect(writes).toEqual([])
  })
})

describe('recentDocuments', () => {
  it('lists the stored handles and reports no location, because a handle has none', async () => {
    const { store } = fakeStore({
      recent: () => Promise.resolve([{ ref: 'doc-1', name: 'report.docx', openedAt: 5 }]),
    })

    const recent = await withPort(store).recentDocuments()

    expect(recent).toEqual([{ ref: 'doc-1', name: 'report.docx' }])
    expect('location' in recent[0]!).toBe(false)
  })
})

describe('pickImage', () => {
  it('reads the picked image as base64 with the mime its extension implies', async () => {
    const { store } = fakeStore()
    const pickers = fakePickers(imageHandle('logo.png', new Uint8Array([1, 2, 3])))

    await expect(withPort(store, granted, pickers).pickImage()).resolves.toEqual({
      base64: 'AQID',
      mime: 'image/png',
      name: 'logo.png',
    })
  })

  it('reports a dismissed dialog as null', async () => {
    const cancel = new Error('The user aborted a request.')
    cancel.name = 'AbortError'
    const { store } = fakeStore()

    await expect(withPort(store, granted, fakePickers(cancel)).pickImage()).resolves.toBeNull()
  })
})

describe('close check over beforeunload', () => {
  /** Capture the beforeunload predicate the window port installs. */
  function windowPort() {
    let shouldPrompt: (() => boolean) | undefined
    const port = createWebDocsWindowPort((predicate) => {
      shouldPrompt = predicate
      return () => {}
    })
    return { port, prompts: () => shouldPrompt!() }
  }

  it('asks its subscribers at unload time and prompts only when the document is dirty', () => {
    const { port, prompts } = windowPort()
    let dirty = false
    port.onCloseCheck(() => port.reportCloseCheck({ dirty, autoSave: false, ref: 'doc-1' }))

    expect(prompts()).toBe(false)
    dirty = true
    expect(prompts()).toBe(true)
  })

  it('does not prompt when nothing is subscribed, so a host with no editor stays quiet', () => {
    expect(windowPort().prompts()).toBe(false)
  })

  it('prompts when a subscriber does not answer synchronously', () => {
    const { port, prompts } = windowPort()
    // A handler that replies later cannot be waited for during unload, so silence
    // is treated as dirty: an extra prompt is recoverable, lost work is not.
    port.onCloseCheck(() => {
      setTimeout(() => port.reportCloseCheck({ dirty: false, autoSave: false, ref: null }), 0)
    })

    expect(prompts()).toBe(true)
  })

  it('stops asking once a subscriber unsubscribes', () => {
    const { port, prompts } = windowPort()
    const off = port.onCloseCheck(() =>
      port.reportCloseCheck({ dirty: true, autoSave: false, ref: null }),
    )

    expect(prompts()).toBe(true)
    off()
    expect(prompts()).toBe(false)
  })
})

describe('the members that must not pretend to work', () => {
  it('exposes close-save, teardown and menu commands as subscriptions with no emissions', () => {
    const port = createWebDocsWindowPort(() => () => {})
    const offs = [
      port.onCloseSaveRequest(() => {
        throw new Error('this host never issues a close-save request')
      }),
      port.onTeardown(() => {
        throw new Error('this host never detaches a live view')
      }),
      port.onMenuCommand(() => {
        throw new Error('this host has no native menu')
      }),
    ]

    expect(() => offs.forEach((off) => off())).not.toThrow()
  })

  it('warns instead of silently accepting a reply to a close-save request never made', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    createWebDocsWindowPort(() => () => {}).reportCloseSaveResult(true)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('never issues a close-save request'))
    warn.mockRestore()
  })
})

/** Independent sha256, so the port's hash is compared against something computed elsewhere. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
