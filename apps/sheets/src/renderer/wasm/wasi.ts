/**
 * WASI preview1, as much of it as the xlsx engine imports and no more.
 *
 * The module built by `npm run wasm:build` asks for exactly twenty-one functions — the list
 * below is that import list, not a general implementation of the standard. Anything outside
 * it is absent on purpose: a shim that answers calls nobody makes is a shim nobody has
 * tested. (`node -e "WebAssembly.Module.imports(…)"` on the built module prints the list, and
 * instantiation fails loudly if it ever grows.)
 *
 * Why hand-written rather than a dependency: the surface is small, every call maps onto
 * `MemFs` in a line or two, and the alternative is shipping a general-purpose WASI runtime to
 * every user of a spreadsheet page. It is also the layer where a mistake is silent — an
 * `fd_read` that returns the wrong count corrupts a workbook rather than failing — so it is
 * worth having under test in this repo.
 *
 * Structures are written little-endian at the offsets preview1 specifies. Each one is
 * documented where it is written, because a wrong offset here is invisible until a workbook
 * comes back subtly wrong.
 */
import { MemFs, MemFsError, readAt, writeAt, type MemDir, type MemFile } from './memfs'

/** preview1 errnos, only the ones this shim can return. */
const E = {
  SUCCESS: 0,
  BADF: 8,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
} as const

const FILETYPE_DIRECTORY = 3
const FILETYPE_REGULAR = 4
const FILETYPE_CHARACTER_DEVICE = 2

const OFLAGS_CREAT = 1 << 0
const OFLAGS_DIRECTORY = 1 << 1
const OFLAGS_EXCL = 1 << 2
const OFLAGS_TRUNC = 1 << 3

/** Every right, granted to everything: this filesystem has no permission model to enforce. */
const ALL_RIGHTS = 0xffff_ffff_ffff_ffffn

/** The first fd handed out after stdin/stdout/stderr and the preopens. */
const FIRST_PREOPEN_FD = 3

interface OpenFile {
  readonly kind: 'file'
  readonly node: MemFile
  readonly path: string
  offset: number
  readonly append: boolean
}

interface OpenDir {
  readonly kind: 'dir'
  readonly node: MemDir
  /** Absolute path, so a `path_*` call on this fd can resolve its argument. */
  readonly path: string
  readonly preopen: string | null
}

type OpenNode = OpenFile | OpenDir

/** Thrown by `proc_exit`; the caller turns it into a failed request rather than a dead page. */
export class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`the engine called proc_exit(${code})`)
    this.name = 'WasiExit'
  }
}

export interface WasiOptions {
  /** Directories the module may reach, keyed by the path it will see them at. */
  preopens: string[]
  /** Where the module's stderr goes. Panics arrive here, so the default is the console. */
  stderr?: (text: string) => void
  /** Injected for tests; production uses `Date.now`. */
  now?: () => number
  /** Injected for tests; production uses `crypto.getRandomValues`. */
  randomFill?: (bytes: Uint8Array) => void
}

/**
 * One module's view of the world: its filesystem, its file descriptors, and the twenty-one
 * functions it may call.
 */
export class WasiHost {
  readonly fs: MemFs
  private readonly fds = new Map<number, OpenNode>()
  private nextFd = FIRST_PREOPEN_FD
  private memory: WebAssembly.Memory | null = null
  private readonly stderr: (text: string) => void
  private readonly now: () => number
  private readonly randomFill: (bytes: Uint8Array) => void
  /** Partial line held back so a panic message arrives as one log entry, not five. */
  private stderrBuffer = ''

  constructor(options: WasiOptions) {
    this.now = options.now ?? (() => Date.now())
    this.stderr = options.stderr ?? ((text) => console.error(`[xlsx-engine] ${text}`))
    this.randomFill =
      options.randomFill ??
      ((bytes) => {
        crypto.getRandomValues(bytes)
      })
    this.fs = new MemFs(this.now)
    for (const path of options.preopens) {
      const dir = this.fs.mkdirp(path)
      this.fds.set(this.nextFd++, { kind: 'dir', node: dir, path, preopen: path })
    }
  }

  /** Called once, after instantiation, with the module's exported memory. */
  bind(memory: WebAssembly.Memory): void {
    this.memory = memory
  }

  private get view(): DataView {
    if (this.memory === null) throw new Error('WASI host used before bind()')
    return new DataView(this.memory.buffer)
  }

  private bytes(pointer: number, length: number): Uint8Array {
    if (this.memory === null) throw new Error('WASI host used before bind()')
    return new Uint8Array(this.memory.buffer, pointer, length)
  }

  private readString(pointer: number, length: number): string {
    return new TextDecoder().decode(this.bytes(pointer, length))
  }

  /** Resolve a `path_*` argument against the directory fd it was given. */
  private resolve(dirFd: number, path: string): string {
    const entry = this.fds.get(dirFd)
    if (entry === undefined || entry.kind !== 'dir') throw E.BADF
    return path.startsWith('/') ? path : `${entry.path}/${path}`
  }

  private file(fd: number): OpenFile {
    const entry = this.fds.get(fd)
    if (entry === undefined) throw E.BADF
    if (entry.kind !== 'file') throw E.ISDIR
    return entry
  }

  /** MemFs failures → errnos. Anything else is a bug and is allowed to escape. */
  private static errnoOf(error: unknown): number {
    if (typeof error === 'number') return error
    if (error instanceof MemFsError) {
      switch (error.code) {
        case 'NOENT':
          return E.NOENT
        case 'NOTDIR':
          return E.NOTDIR
        case 'ISDIR':
          return E.ISDIR
        case 'EXIST':
          return E.EXIST
        case 'NOTEMPTY':
          return E.NOTEMPTY
        case 'INVAL':
          return E.INVAL
      }
    }
    throw error
  }

  /** Wrap a syscall body so every failure becomes an errno the module understands. */
  private guard(body: () => number): number {
    try {
      return body()
    } catch (error) {
      if (error instanceof WasiExit) throw error
      return WasiHost.errnoOf(error)
    }
  }

  /** Write stderr through, one line at a time. */
  private writeStderr(chunk: Uint8Array): void {
    this.stderrBuffer += new TextDecoder().decode(chunk)
    const lines = this.stderrBuffer.split('\n')
    this.stderrBuffer = lines.pop() ?? ''
    for (const line of lines) if (line.length > 0) this.stderr(line)
  }

  /** `filestat`: 64 bytes — dev, ino, filetype (+7 pad), nlink, size, atim, mtim, ctim. */
  private writeFilestat(pointer: number, node: MemFile | MemDir): void {
    const view = this.view
    const nanos = BigInt(Math.round(node.createdMs)) * 1_000_000n
    view.setBigUint64(pointer, 0n, true)
    view.setBigUint64(pointer + 8, 0n, true)
    view.setUint8(pointer + 16, node.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_REGULAR)
    view.setBigUint64(pointer + 24, 1n, true)
    view.setBigUint64(pointer + 32, BigInt(node.kind === 'file' ? node.size : 0), true)
    view.setBigUint64(pointer + 40, nanos, true)
    view.setBigUint64(pointer + 48, nanos, true)
    view.setBigUint64(pointer + 56, nanos, true)
  }

  /** The import object to instantiate the module with. */
  get imports(): Record<string, WebAssembly.ImportValue> {
    return {
      // ── clocks and randomness ──
      clock_time_get: (_id: number, _precision: bigint, timePointer: number): number =>
        this.guard(() => {
          this.view.setBigUint64(timePointer, BigInt(Math.round(this.now())) * 1_000_000n, true)
          return E.SUCCESS
        }),
      random_get: (pointer: number, length: number): number =>
        this.guard(() => {
          this.randomFill(this.bytes(pointer, length))
          return E.SUCCESS
        }),

      // ── environment: empty, and said so exactly once ──
      environ_sizes_get: (countPointer: number, sizePointer: number): number =>
        this.guard(() => {
          this.view.setUint32(countPointer, 0, true)
          this.view.setUint32(sizePointer, 0, true)
          return E.SUCCESS
        }),
      environ_get: (): number => E.SUCCESS,

      // ── descriptors ──
      fd_prestat_get: (fd: number, pointer: number): number =>
        this.guard(() => {
          const entry = this.fds.get(fd)
          if (entry === undefined || entry.kind !== 'dir' || entry.preopen === null) return E.BADF
          // prestat: u8 tag (0 = dir) + u32 name length at offset 4.
          this.view.setUint8(pointer, 0)
          this.view.setUint32(pointer + 4, new TextEncoder().encode(entry.preopen).length, true)
          return E.SUCCESS
        }),
      fd_prestat_dir_name: (fd: number, pointer: number, length: number): number =>
        this.guard(() => {
          const entry = this.fds.get(fd)
          if (entry === undefined || entry.kind !== 'dir' || entry.preopen === null) return E.BADF
          const name = new TextEncoder().encode(entry.preopen)
          if (name.length > length) return E.INVAL
          this.bytes(pointer, name.length).set(name)
          return E.SUCCESS
        }),
      fd_fdstat_get: (fd: number, pointer: number): number =>
        this.guard(() => {
          const entry = this.fds.get(fd)
          const view = this.view
          // fdstat: filetype u8, pad, fdflags u16, rights_base u64, rights_inheriting u64.
          if (entry === undefined) {
            // stdin/stdout/stderr are not in the table; std stats them at startup.
            if (fd > 2) return E.BADF
            view.setUint8(pointer, FILETYPE_CHARACTER_DEVICE)
            view.setUint16(pointer + 2, 0, true)
            view.setBigUint64(pointer + 8, ALL_RIGHTS, true)
            view.setBigUint64(pointer + 16, ALL_RIGHTS, true)
            return E.SUCCESS
          }
          view.setUint8(pointer, entry.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_REGULAR)
          view.setUint16(pointer + 2, 0, true)
          view.setBigUint64(pointer + 8, ALL_RIGHTS, true)
          view.setBigUint64(pointer + 16, ALL_RIGHTS, true)
          return E.SUCCESS
        }),
      fd_filestat_get: (fd: number, pointer: number): number =>
        this.guard(() => {
          const entry = this.fds.get(fd)
          if (entry === undefined) return E.BADF
          this.writeFilestat(pointer, entry.node)
          return E.SUCCESS
        }),
      fd_close: (fd: number): number =>
        this.guard(() => (this.fds.delete(fd) ? E.SUCCESS : E.BADF)),
      fd_sync: (): number => E.SUCCESS,

      fd_read: (fd: number, iovsPointer: number, iovsLength: number, readPointer: number): number =>
        this.guard(() => {
          const open = this.file(fd)
          let total = 0
          for (let index = 0; index < iovsLength; index += 1) {
            // iovec: buffer pointer u32, buffer length u32.
            const base = this.view.getUint32(iovsPointer + index * 8, true)
            const length = this.view.getUint32(iovsPointer + index * 8 + 4, true)
            const chunk = readAt(open.node, open.offset, length)
            if (chunk.length === 0) break
            this.bytes(base, chunk.length).set(chunk)
            open.offset += chunk.length
            total += chunk.length
            if (chunk.length < length) break
          }
          this.view.setUint32(readPointer, total, true)
          return E.SUCCESS
        }),
      fd_write: (
        fd: number,
        iovsPointer: number,
        iovsLength: number,
        writtenPointer: number,
      ): number =>
        this.guard(() => {
          let total = 0
          const open = fd > 2 ? this.file(fd) : null
          for (let index = 0; index < iovsLength; index += 1) {
            const base = this.view.getUint32(iovsPointer + index * 8, true)
            const length = this.view.getUint32(iovsPointer + index * 8 + 4, true)
            const chunk = this.bytes(base, length)
            if (open === null) {
              // stdout and stderr both go to the log: the engine writes nothing to stdout in
              // this build, and a panic message must never be swallowed.
              this.writeStderr(chunk)
              total += length
              continue
            }
            const offset = open.append ? open.node.size : open.offset
            total += writeAt(open.node, offset, chunk)
            open.offset = offset + length
          }
          this.view.setUint32(writtenPointer, total, true)
          return E.SUCCESS
        }),
      fd_seek: (fd: number, offset: bigint, whence: number, newPointer: number): number =>
        this.guard(() => {
          const open = this.file(fd)
          const base = whence === 0 ? 0 : whence === 1 ? open.offset : open.node.size
          const next = base + Number(offset)
          if (next < 0) return E.INVAL
          open.offset = next
          this.view.setBigUint64(newPointer, BigInt(next), true)
          return E.SUCCESS
        }),
      fd_readdir: (
        fd: number,
        pointer: number,
        length: number,
        cookie: bigint,
        usedPointer: number,
      ): number =>
        this.guard(() => {
          const entry = this.fds.get(fd)
          if (entry === undefined || entry.kind !== 'dir') return E.BADF
          const names = [...entry.node.entries.entries()]
          let used = 0
          let index = Number(cookie)
          const encoder = new TextEncoder()
          while (index < names.length) {
            const [name, node] = names[index]!
            const encoded = encoder.encode(name)
            // dirent: d_next u64, d_ino u64, d_namlen u32, d_type u8 (+3 pad) = 24 bytes.
            if (used + 24 + encoded.length > length) break
            const view = this.view
            view.setBigUint64(pointer + used, BigInt(index + 1), true)
            view.setBigUint64(pointer + used + 8, 0n, true)
            view.setUint32(pointer + used + 16, encoded.length, true)
            view.setUint8(
              pointer + used + 20,
              node.kind === 'dir' ? FILETYPE_DIRECTORY : FILETYPE_REGULAR,
            )
            this.bytes(pointer + used + 24, encoded.length).set(encoded)
            used += 24 + encoded.length
            index += 1
          }
          this.view.setUint32(usedPointer, used, true)
          return E.SUCCESS
        }),

      // ── paths ──
      path_open: (
        dirFd: number,
        _dirFlags: number,
        pathPointer: number,
        pathLength: number,
        oflags: number,
        _rightsBase: bigint,
        _rightsInheriting: bigint,
        fdflags: number,
        openedPointer: number,
      ): number =>
        this.guard(() => {
          const path = this.resolve(dirFd, this.readString(pathPointer, pathLength))
          const wantsDirectory = (oflags & OFLAGS_DIRECTORY) !== 0
          const exists = this.fs.exists(path)
          if ((oflags & OFLAGS_EXCL) !== 0 && exists) return E.EXIST
          let node
          if (!exists && (oflags & OFLAGS_CREAT) !== 0 && !wantsDirectory) {
            node = this.fs.createFile(path, true)
          } else {
            node = this.fs.lookup(path)
            if (node.kind === 'file' && (oflags & OFLAGS_TRUNC) !== 0) node.size = 0
          }
          if (wantsDirectory && node.kind !== 'dir') return E.NOTDIR
          const fd = this.nextFd++
          this.fds.set(
            fd,
            node.kind === 'dir'
              ? { kind: 'dir', node, path, preopen: null }
              : // fdflags bit 0 is APPEND.
                { kind: 'file', node, path, offset: 0, append: (fdflags & 1) !== 0 },
          )
          this.view.setUint32(openedPointer, fd, true)
          return E.SUCCESS
        }),
      path_filestat_get: (
        dirFd: number,
        _flags: number,
        pathPointer: number,
        pathLength: number,
        bufferPointer: number,
      ): number =>
        this.guard(() => {
          const path = this.resolve(dirFd, this.readString(pathPointer, pathLength))
          this.writeFilestat(bufferPointer, this.fs.lookup(path))
          return E.SUCCESS
        }),
      path_create_directory: (dirFd: number, pathPointer: number, pathLength: number): number =>
        this.guard(() => {
          this.fs.mkdir(this.resolve(dirFd, this.readString(pathPointer, pathLength)))
          return E.SUCCESS
        }),
      path_remove_directory: (dirFd: number, pathPointer: number, pathLength: number): number =>
        this.guard(() => {
          this.fs.rmdir(this.resolve(dirFd, this.readString(pathPointer, pathLength)))
          return E.SUCCESS
        }),
      path_unlink_file: (dirFd: number, pathPointer: number, pathLength: number): number =>
        this.guard(() => {
          this.fs.unlink(this.resolve(dirFd, this.readString(pathPointer, pathLength)))
          return E.SUCCESS
        }),

      // ── the two that only have to exist ──
      // Nothing in this engine waits on anything: it is called, it computes, it returns.
      poll_oneoff: (): number => E.NOSYS,
      proc_exit: (code: number): never => {
        throw new WasiExit(code)
      },
    }
  }
}
