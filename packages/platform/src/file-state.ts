/**
 * Conflict detection for a document being saved back over itself.
 *
 * The only runtime logic in this package, and it is here because both hosts need
 * exactly the same answer. Every editor built on these ports reads a document,
 * lets the user edit it, and later writes the whole file back — so all of them
 * have to notice when *another* program wrote that file in between, or the write
 * silently discards someone else's work.
 *
 * It is a pure predicate over three inputs and nothing else: no filesystem, no
 * `File`, no host API. That is what makes it shared rather than duplicated. The
 * Electron main process supplies the numbers from `fs.stat` plus a hash of the
 * bytes it last wrote; a browser host supplies them from a
 * `FileSystemFileHandle`'s `File`, whose `lastModified` and `size` are the same
 * two facts, and hashes through the same handle. Both then behave identically,
 * which is the point — a browser that skipped this check would be a data-loss bug
 * that the desktop build does not have.
 *
 * (This is the one exception to "interfaces plus a slot factory" in index.ts, and
 * it is a deliberate one: a *port* would be wrong here, because there is nothing
 * host-specific to abstract — the hosts differ in where the numbers come from,
 * not in what the numbers mean.)
 */

/** Disk snapshot recorded at the last read/write of a document. */
export interface DiskFileState {
  /**
   * Last-modified time in epoch milliseconds. `fs.Stats.mtimeMs` on Electron,
   * `File.lastModified` in a browser — the same quantity from both.
   */
  mtimeMs: number
  size: number
  /** sha256 (hex) of the bytes the host last read or wrote. */
  hash: string
}

/**
 * True when the file no longer matches the recorded state, i.e. another program
 * wrote it since we last read/saved it. No record (never tracked) or a missing
 * file (deleted externally) is not a conflict — the save proceeds and recreates
 * the file. The hash read only runs when mtime+size already disagree, so the
 * common no-conflict save never rereads the file.
 */
export async function isExternallyModified(
  recorded: DiskFileState | undefined,
  current: { mtimeMs: number; size: number } | null,
  readHash: () => string | null | Promise<string | null>,
): Promise<boolean> {
  if (!recorded || !current) return false
  if (current.mtimeMs === recorded.mtimeMs && current.size === recorded.size) return false
  const hash = await readHash()
  return hash !== null && hash !== recorded.hash
}
