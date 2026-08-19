import { describe, expect, it } from 'vitest'

import { openExternalUrl, safeExternalUrl } from '../src/index'

describe('safeExternalUrl', () => {
  it('accepts http and https URLs', () => {
    expect(safeExternalUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com')
  })

  it('rejects non-string input', () => {
    expect(safeExternalUrl(undefined)).toBeNull()
    expect(safeExternalUrl(null)).toBeNull()
    expect(safeExternalUrl(42)).toBeNull()
    expect(safeExternalUrl({ toString: () => 'https://example.com' })).toBeNull()
  })

  it('rejects malformed URLs', () => {
    expect(safeExternalUrl('not a url')).toBeNull()
    expect(safeExternalUrl('')).toBeNull()
    expect(safeExternalUrl('http//missing-colon.com')).toBeNull()
  })

  it('rejects dangerous protocols by default', () => {
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('smb://server/share')).toBeNull()
    expect(safeExternalUrl('mailto:a@b.com')).toBeNull()
    // prefix tricks that pass a bare startsWith('http') check
    expect(safeExternalUrl('httpx://evil.example')).toBeNull()
  })

  it('supports a custom protocol allowlist', () => {
    const opts = { allowedProtocols: ['https:', 'mailto:'] }
    expect(safeExternalUrl('mailto:a@b.com', opts)).toBe('mailto:a@b.com')
    expect(safeExternalUrl('http://example.com', opts)).toBeNull()
  })
})

describe('openExternalUrl', () => {
  const withWindow = (open: (...args: unknown[]) => unknown, run: () => void) => {
    const scope = globalThis as { window?: unknown }
    const had = 'window' in scope
    const previous = scope.window
    scope.window = { open }
    try {
      run()
    } finally {
      if (had) scope.window = previous
      else delete scope.window
    }
  }

  it('opens an allowed URL with no handle back on this page', () => {
    const calls: unknown[][] = []
    withWindow(
      (...args) => calls.push(args),
      () => openExternalUrl('https://example.com/a'),
    )
    expect(calls).toEqual([['https://example.com/a', '_blank', 'noopener,noreferrer']])
  })

  it('opens nothing at all for a rejected URL', () => {
    const calls: unknown[][] = []
    withWindow(
      (...args) => calls.push(args),
      () => {
        openExternalUrl('javascript:alert(1)')
        openExternalUrl('file:///etc/passwd')
        openExternalUrl('mailto:a@b.c')
        openExternalUrl(undefined)
      },
    )
    expect(calls).toEqual([])
  })

  it('honours a wider allowlist when the caller passes one', () => {
    const calls: unknown[][] = []
    withWindow(
      (...args) => calls.push(args),
      () => openExternalUrl('mailto:a@b.c', { allowedProtocols: ['mailto:'] }),
    )
    expect(calls).toHaveLength(1)
  })
})
