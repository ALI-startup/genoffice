/**
 * Handing bytes to the user as a download (src/download.ts).
 *
 * The mechanism is three lines of DOM, and the two things worth pinning down are
 * both invisible from the outside: that the object URL is revoked, and that it is
 * revoked *later*. Revoking in the same task as the click cancels the download in
 * Chromium, which is a bug no assertion about the anchor would catch — so the
 * environment is injected and the deferral is observed directly.
 */
import { describe, expect, it } from 'vitest'
import { browserDownloadEnv, DOWNLOAD_URL_TTL_MS, downloadBytes } from '../src/download'
import type { DownloadEnv } from '../src/download'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

interface Recorder {
  env: DownloadEnv
  created: Blob[]
  revoked: string[]
  started: Array<{ url: string; fileName: string }>
  /** Deferred tasks, un-run: a test decides when (and whether) they fire. */
  deferred: Array<() => void>
}

function recorder(overrides: Partial<DownloadEnv> = {}): Recorder {
  const created: Blob[] = []
  const revoked: string[] = []
  const started: Recorder['started'] = []
  const deferred: Array<() => void> = []
  const env: DownloadEnv = {
    createObjectUrl: (blob) => {
      created.push(blob)
      return `blob:${created.length}`
    },
    revokeObjectUrl: (url) => void revoked.push(url),
    startDownload: (url, fileName) => void started.push({ url, fileName }),
    defer: (task) => void deferred.push(task),
    ...overrides,
  }
  return { env, created, revoked, started, deferred }
}

describe('downloadBytes', () => {
  it('starts a download of the bytes under the given name and type', async () => {
    const { env, created, started } = recorder()

    downloadBytes(env, 'report.docx', new Uint8Array([1, 2, 3]), DOCX_MIME)

    expect(started).toEqual([{ url: 'blob:1', fileName: 'report.docx' }])
    expect(created).toHaveLength(1)
    expect(created[0]!.type).toBe(DOCX_MIME)
    expect([...new Uint8Array(await created[0]!.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('accepts an ArrayBuffer as well, which is what the port is handed', async () => {
    const { env, created } = recorder()

    downloadBytes(env, 'report.docx', new Uint8Array([9, 8]).buffer, DOCX_MIME)

    expect([...new Uint8Array(await created[0]!.arrayBuffer())]).toEqual([9, 8])
  })

  it('revokes the url only after the current task, or the download is cancelled', () => {
    const { env, revoked, deferred } = recorder()

    downloadBytes(env, 'report.docx', new Uint8Array([1]), DOCX_MIME)

    // Nothing revoked yet: at this point the browser has only been *told* to fetch
    // the blob. This is the assertion that a "tidy up straight after the click"
    // refactor has to fail.
    expect(revoked).toEqual([])
    expect(deferred).toHaveLength(1)

    deferred[0]!()
    expect(revoked).toEqual(['blob:1'])
  })

  it('revokes immediately when the handover itself throws, so nothing leaks', () => {
    const { env, revoked, deferred } = recorder({
      startDownload: () => {
        throw new Error('downloads are blocked in this frame')
      },
    })

    expect(() => downloadBytes(env, 'report.docx', new Uint8Array([1]), DOCX_MIME)).toThrow(
      'downloads are blocked',
    )
    // No download was started, so there is nothing to wait for: the blob is freed
    // now rather than being kept alive by a deferral that has no purpose.
    expect(revoked).toEqual(['blob:1'])
    expect(deferred).toEqual([])
  })

  it('copies the bytes, so a caller reusing its buffer cannot alter the download', async () => {
    const { env, created } = recorder()
    const bytes = new Uint8Array([1, 2, 3])

    downloadBytes(env, 'report.docx', bytes, DOCX_MIME)
    bytes[0] = 99

    expect([...new Uint8Array(await created[0]!.arrayBuffer())]).toEqual([1, 2, 3])
  })
})

describe('browserDownloadEnv', () => {
  it('clicks an <a download> that is in the document, and takes it out again', () => {
    const clicks: string[] = []
    const appended: FakeAnchor[] = []
    const { scope, body } = fakeDom(clicks, appended)

    browserDownloadEnv(scope).startDownload('blob:1', 'report.docx')

    expect(appended).toHaveLength(1)
    expect(appended[0]!.href).toBe('blob:1')
    // The attribute is what makes this a download rather than a navigation.
    expect(appended[0]!.download).toBe('report.docx')
    expect(clicks).toEqual(['blob:1'])
    // Added and removed within one task, so the page never sees the node.
    expect(body.children).toEqual([])
  })

  it('removes the anchor even when the click throws', () => {
    const appended: FakeAnchor[] = []
    const { scope, body } = fakeDom([], appended, () => {
      throw new Error('blocked')
    })

    expect(() => browserDownloadEnv(scope).startDownload('blob:1', 'report.docx')).toThrow(
      'blocked',
    )
    expect(body.children).toEqual([])
  })

  it('defers the revoke by the url ttl, not by zero', () => {
    const timers: Array<{ ms: number }> = []
    const { scope } = fakeDom([], [], undefined, (_task, ms) => void timers.push({ ms }))

    browserDownloadEnv(scope).defer(() => {})

    expect(timers).toEqual([{ ms: DOWNLOAD_URL_TTL_MS }])
  })
})

interface FakeAnchor {
  href: string
  download: string
  rel: string
  style: { display: string }
  click(): void
  remove(): void
}

/**
 * The smallest DOM `browserDownloadEnv` touches.
 *
 * Hand-rolled rather than jsdom because this package's suite runs in node on
 * purpose (see vitest.config.ts) and the surface is four members wide.
 */
function fakeDom(
  clicks: string[],
  appended: FakeAnchor[],
  onClick?: () => void,
  /** Replaces the timer, for the test that checks *when* the revoke is scheduled. */
  schedule: (task: () => void, ms: number) => void = (task) => task(),
): {
  scope: Parameters<typeof browserDownloadEnv>[0]
  body: { children: FakeAnchor[] }
} {
  const body = { children: [] as FakeAnchor[] }
  const document = {
    createElement: (): FakeAnchor => {
      const anchor: FakeAnchor = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: () => {
          if (onClick) onClick()
          clicks.push(anchor.href)
        },
        remove: () => {
          body.children = body.children.filter((child) => child !== anchor)
        },
      }
      return anchor
    },
    body: {
      appendChild: (anchor: FakeAnchor) => {
        appended.push(anchor)
        body.children.push(anchor)
      },
    },
  }
  return {
    scope: {
      document,
      URL: { createObjectURL: () => 'blob:1', revokeObjectURL: () => {} },
      setTimeout: (task: () => void, ms: number) => void schedule(task, ms),
    } as unknown as Parameters<typeof browserDownloadEnv>[0],
    body,
  }
}
