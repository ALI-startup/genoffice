/**
 * The filesystem the xlsx engine sees in a browser.
 *
 * The engine opens workbooks by path, extracts a session's parts into a scratch directory
 * and writes archives back out — that is its design on every host, and the reason the wasm
 * build targets WASI rather than a byte-oriented rewrite (see native/xlsx-engine/src/wasm.rs).
 * A page has no filesystem to offer it, so this is one: directories and files held in memory,
 * with the operations preview1 actually asks for and no others.
 *
 * Deliberately not a general-purpose filesystem. There are no permissions, no links, no
 * timestamps beyond a creation clock, and no attempt at atomicity — the single writer is a
 * single-threaded wasm module, and the whole thing lives for as long as one workbook is open.
 * What it does have to be is exact about the things the engine relies on: reading and writing
 * at an offset, truncation on create, and directory listing.
 */

/** A file's bytes, grown as it is written. */
export interface MemFile {
  readonly kind: 'file'
  data: Uint8Array
  /** Bytes actually written; `data` may be larger, since it grows geometrically. */
  size: number
  readonly createdMs: number
}

export interface MemDir {
  readonly kind: 'dir'
  readonly entries: Map<string, MemNode>
  readonly createdMs: number
}

export type MemNode = MemFile | MemDir

/** Thrown for every failure the syscall layer turns into an errno. */
export class MemFsError extends Error {
  constructor(readonly code: 'NOENT' | 'NOTDIR' | 'ISDIR' | 'EXIST' | 'NOTEMPTY' | 'INVAL') {
    super(code)
    this.name = 'MemFsError'
  }
}

function fail(code: MemFsError['code']): never {
  throw new MemFsError(code)
}

/** Split a path into its components, ignoring empty and `.` segments. */
export function splitPath(path: string): string[] {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // The engine never walks upward, and honouring `..` here would let a path escape a
      // preopen — the one thing a browser filesystem must not allow.
      fail('INVAL')
    }
    parts.push(part)
  }
  return parts
}

export class MemFs {
  readonly root: MemDir

  constructor(private readonly now: () => number = () => Date.now()) {
    this.root = { kind: 'dir', entries: new Map(), createdMs: this.now() }
  }

  /** The node at `path`, or a NOENT failure. */
  lookup(path: string): MemNode {
    let node: MemNode = this.root
    for (const part of splitPath(path)) {
      if (node.kind !== 'dir') fail('NOTDIR')
      const next = node.entries.get(part)
      if (next === undefined) fail('NOENT')
      node = next
    }
    return node
  }

  exists(path: string): boolean {
    try {
      this.lookup(path)
      return true
    } catch {
      return false
    }
  }

  /** The directory holding `path`, and the final component's name. */
  private parentOf(path: string): { parent: MemDir; name: string } {
    const parts = splitPath(path)
    const name = parts.pop()
    if (name === undefined) fail('INVAL')
    let node: MemNode = this.root
    for (const part of parts) {
      if (node.kind !== 'dir') fail('NOTDIR')
      const next = node.entries.get(part)
      if (next === undefined) fail('NOENT')
      node = next
    }
    if (node.kind !== 'dir') fail('NOTDIR')
    return { parent: node, name }
  }

  /** Create every missing directory along `path`. */
  mkdirp(path: string): MemDir {
    let node: MemDir = this.root
    for (const part of splitPath(path)) {
      const existing = node.entries.get(part)
      if (existing === undefined) {
        const created: MemDir = { kind: 'dir', entries: new Map(), createdMs: this.now() }
        node.entries.set(part, created)
        node = created
        continue
      }
      if (existing.kind !== 'dir') fail('NOTDIR')
      node = existing
    }
    return node
  }

  mkdir(path: string): void {
    const { parent, name } = this.parentOf(path)
    if (parent.entries.has(name)) fail('EXIST')
    parent.entries.set(name, { kind: 'dir', entries: new Map(), createdMs: this.now() })
  }

  /** Create or truncate a file, returning it. */
  createFile(path: string, truncate: boolean): MemFile {
    const { parent, name } = this.parentOf(path)
    const existing = parent.entries.get(name)
    if (existing !== undefined) {
      if (existing.kind !== 'file') fail('ISDIR')
      if (truncate) existing.size = 0
      return existing
    }
    const file: MemFile = {
      kind: 'file',
      data: new Uint8Array(0),
      size: 0,
      createdMs: this.now(),
    }
    parent.entries.set(name, file)
    return file
  }

  /** Write a whole file, creating parents as needed. The host's way in and out. */
  writeFile(path: string, bytes: Uint8Array): void {
    const parts = splitPath(path)
    if (parts.length > 1) this.mkdirp(parts.slice(0, -1).join('/'))
    const file = this.createFile(path, true)
    file.data = new Uint8Array(bytes)
    file.size = bytes.length
  }

  /** A copy of a file's bytes. */
  readFile(path: string): Uint8Array {
    const node = this.lookup(path)
    if (node.kind !== 'file') fail('ISDIR')
    return node.data.slice(0, node.size)
  }

  unlink(path: string): void {
    const { parent, name } = this.parentOf(path)
    const node = parent.entries.get(name)
    if (node === undefined) fail('NOENT')
    if (node.kind === 'dir') fail('ISDIR')
    parent.entries.delete(name)
  }

  /** Remove a node and everything under it. `rm -rf`, for dropping a closed workbook. */
  removeAll(path: string): void {
    const { parent, name } = this.parentOf(path)
    parent.entries.delete(name)
  }

  rmdir(path: string): void {
    const { parent, name } = this.parentOf(path)
    const node = parent.entries.get(name)
    if (node === undefined) fail('NOENT')
    if (node.kind !== 'dir') fail('NOTDIR')
    if (node.entries.size > 0) fail('NOTEMPTY')
    parent.entries.delete(name)
  }
}

/** Write `bytes` into `file` at `offset`, growing it as needed. Returns bytes written. */
export function writeAt(file: MemFile, offset: number, bytes: Uint8Array): number {
  const end = offset + bytes.length
  if (end > file.data.length) {
    // Geometric growth: a workbook's parts are written in many small chunks, and copying the
    // whole buffer per chunk turns a save into an O(n²) crawl.
    const grown = new Uint8Array(Math.max(end, file.data.length * 2, 1024))
    grown.set(file.data.subarray(0, file.size))
    file.data = grown
  }
  file.data.set(bytes, offset)
  if (end > file.size) file.size = end
  return bytes.length
}

/** Read up to `length` bytes from `offset`. Returns a view, not a copy. */
export function readAt(file: MemFile, offset: number, length: number): Uint8Array {
  if (offset >= file.size) return new Uint8Array(0)
  return file.data.subarray(offset, Math.min(offset + length, file.size))
}
