/** Conflict detection for a document being saved back over itself. */

/** Disk snapshot recorded at the last read/write of a document. */
export interface DiskFileState {
  /** Last-modified time in epoch milliseconds. */
  mtimeMs: number
  size: number
  /** sha256 (hex) of the bytes the host last read or wrote. */
  hash: string
}

/** True when the file no longer matches the recorded state, i.e. */
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
