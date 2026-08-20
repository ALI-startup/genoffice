/**
 * The route, over a real socket, with a fake JVM behind it.
 *
 * A real `node:http` server rather than a hand-rolled request object, because
 * the things worth asserting are HTTP's: the status that separates "your file"
 * from "our deployment", the content type the browser reads the body as, and the
 * body limit, which only exists on the wire.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONVERT_ROUTES,
  HWPX_MIME,
  type ConvertErrorBody,
} from '@samugen/platform-web/convert-wire'
import { createHwpConvertHandler, type HwpConvertOptions } from '../src/server'
import type { JavaRun, RunJava } from '../src/convert'
import { writeFile } from 'node:fs/promises'

const HWP = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 7, 7, 7])
const HWPX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9])

let running: Server | null = null

afterEach(async () => {
  const server = running
  running = null
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function serve(options: HwpConvertOptions): Promise<string> {
  const server = createServer(createHwpConvertHandler(options))
  running = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

/** Writes HWPX to the output path and answers with `result`. */
function fakeJava(result: JavaRun, output = HWPX): RunJava {
  return async (args) => {
    if (args.length > 3) await writeFile(args[3], output)
    return result
  }
}

const okRun: JavaRun = { code: 0, timedOut: false, stderr: '' }

describe('POST /v1/convert/hwp-to-hwpx', () => {
  it('answers with the package bytes and the OWPML content type', async () => {
    const base = await serve({ runJava: fakeJava(okRun) })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, { method: 'POST', body: HWP })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(HWPX_MIME)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(HWPX)
  })

  it('rejects a file that is not an HWP with 400 and reason invalid', async () => {
    const base = await serve({ runJava: fakeJava(okRun) })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, {
      method: 'POST',
      body: new Uint8Array([0x50, 0x4b, 3, 4]),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ reason: 'invalid' })
  })

  it('rejects an empty body rather than starting a JVM for it', async () => {
    const base = await serve({ runJava: fakeJava(okRun) })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, {
      method: 'POST',
      body: new Uint8Array(),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ reason: 'invalid' })
  })

  it('answers 503 when the converter is missing, so the UI can say so', async () => {
    // The distinction that matters: this is not the user's file being wrong.
    const base = await serve({ runJava: () => Promise.reject(new Error('spawn java ENOENT')) })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, { method: 'POST', body: HWP })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ reason: 'unsupported' })
  })

  it('answers 422 with the converter message when it refused the document', async () => {
    const base = await serve({
      runJava: fakeJava({ code: 2, timedOut: false, stderr: 'Conversion failed: bad record' }),
    })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, { method: 'POST', body: HWP })

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      reason: 'failed',
      error: 'Conversion failed: bad record',
    })
  })

  it('answers 504 on a timeout', async () => {
    const base = await serve({
      runJava: fakeJava({ code: null, timedOut: true, stderr: '' }),
      timeoutMs: 25,
    })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, { method: 'POST', body: HWP })

    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ reason: 'timeout' })
  })

  it('refuses a body over the limit with 413', async () => {
    const base = await serve({ runJava: fakeJava(okRun), maxBodyBytes: 32 })
    const big = new Uint8Array(4096)
    big.set(HWP)
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx, {
      method: 'POST',
      body: big,
    }).catch(() => null)

    // The body is abandoned as soon as it passes the limit, so a client can see
    // either the 413 or a reset connection. Both are the refusal; what must not
    // happen is the whole upload being accepted.
    if (response) {
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ reason: 'too-large' })
    }
  })

  it('refuses a GET on the conversion route', async () => {
    const base = await serve({ runJava: fakeJava(okRun) })
    const response = await fetch(base + CONVERT_ROUTES.hwpToHwpx)

    expect(response.status).toBe(405)
  })
})

describe('health', () => {
  it('reports the converter as usable when the JAR runs', async () => {
    const base = await serve({ runJava: fakeJava({ code: 1, timedOut: false, stderr: 'Usage' }) })

    for (const path of ['/health', CONVERT_ROUTES.health]) {
      const response = await fetch(base + path)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, converter: true })
    }
  })

  it('stays up and reports converter:false when there is no JVM', async () => {
    // Load-bearing: the browser asks this before offering .hwp in a dialog, so
    // the service must answer rather than refuse to boot.
    const base = await serve({ runJava: () => Promise.reject(new Error('ENOENT')) })
    const response = await fetch(base + '/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, converter: false })
  })
})

describe('anything else', () => {
  it('is a 404 naming the method and path', async () => {
    const base = await serve({ runJava: fakeJava(okRun) })
    const response = await fetch(base + '/v1/convert/pdf-to-hwpx', { method: 'POST' })

    expect(response.status).toBe(404)
    const body = (await response.json()) as ConvertErrorBody
    expect(body.error).toContain('/v1/convert/pdf-to-hwpx')
  })
})
