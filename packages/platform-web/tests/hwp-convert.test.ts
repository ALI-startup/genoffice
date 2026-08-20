/**
 * The browser's side of the conversion service, over a fake `fetch`.
 *
 * The two behaviours worth pinning are the ones a UI depends on: `available()`
 * distinguishes "the service is there but has no converter" from "there is no
 * service", and it asks once per page rather than once per file — a dialog that
 * probed on every pick would be a request per keystroke of hesitation.
 */
import { describe, expect, it, vi } from 'vitest'
import { CONVERT_ROUTES } from '../src/convert-wire'
import { createWebHwpConvertPort } from '../src/hwp-convert'

const HWP = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const HWPX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('available', () => {
  it('is true only when the service reports a usable converter', async () => {
    const yes = createWebHwpConvertPort({
      fetchImpl: async () => jsonResponse(200, { ok: true, converter: true }),
    })
    const no = createWebHwpConvertPort({
      fetchImpl: async () => jsonResponse(200, { ok: true, converter: false }),
    })

    expect(await yes.available()).toBe(true)
    expect(await no.available()).toBe(false)
  })

  it('is false when nothing answers, without surfacing an error', async () => {
    const port = createWebHwpConvertPort({
      fetchImpl: () => Promise.reject(new Error('Failed to fetch')),
    })
    await expect(port.available()).resolves.toBe(false)
  })

  it('is false when a proxy answers the route with something else', async () => {
    const port = createWebHwpConvertPort({
      fetchImpl: async () => new Response('<!doctype html>', { status: 404 }),
    })
    expect(await port.available()).toBe(false)
  })

  it('asks once and reuses the answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { ok: true, converter: true }),
    )
    const port = createWebHwpConvertPort({ fetchImpl })

    expect(await Promise.all([port.available(), port.available()])).toEqual([true, true])
    await port.available()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(CONVERT_ROUTES.health)
  })
})

describe('toHwpx', () => {
  it('posts the bytes and returns the package', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(HWPX, { status: 200 }))
    const port = createWebHwpConvertPort({ fetchImpl })
    const result = await port.toHwpx(HWP)

    expect(result).toEqual({ ok: true, bytes: HWPX })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(CONVERT_ROUTES.hwpToHwpx)
    expect(init?.method).toBe('POST')
  })

  it('sends only the view it was given, not the pool behind it', async () => {
    // A `Uint8Array` from a larger buffer would otherwise post the whole buffer.
    const pool = new Uint8Array(64)
    pool.set(HWP, 8)
    const view = pool.subarray(8, 8 + HWP.length)
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(HWPX, { status: 200 }))
    await createWebHwpConvertPort({ fetchImpl }).toHwpx(view)

    const body = fetchImpl.mock.calls[0][1]?.body as Uint8Array
    expect(body.byteLength).toBe(HWP.length)
    expect(body).toEqual(HWP)
  })

  it('passes the service reason and message through', async () => {
    const port = createWebHwpConvertPort({
      fetchImpl: async () =>
        jsonResponse(422, { reason: 'failed', error: 'Conversion failed: bad record' }),
    })

    expect(await port.toHwpx(HWP)).toEqual({
      ok: false,
      reason: 'failed',
      error: 'Conversion failed: bad record',
    })
  })

  it('reports a transport failure as unreachable, distinctly from a refusal', async () => {
    const port = createWebHwpConvertPort({
      fetchImpl: () => Promise.reject(new Error('Failed to fetch')),
    })

    expect(await port.toHwpx(HWP)).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('reports a non-JSON error body by its status', async () => {
    const port = createWebHwpConvertPort({
      fetchImpl: async () => new Response('<html>502</html>', { status: 502 }),
    })
    const result = await port.toHwpx(HWP)

    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(result.ok ? '' : result.error).toContain('502')
  })
})
