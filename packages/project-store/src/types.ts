/** project-store type definitions. */

// ──────────────────────────────────────────────────────────── Tool types
// ────────────────────────────────────────────────────────────

export interface ToolActivity {
  name: string
  summary: string
  isError?: boolean
  /** Tool input (JSON-serialized; truncated by the store layer) */
  input?: string
  /** Tool output (truncated by the store layer) */
  output?: string
}

/** Attachment metadata recorded with a user message (reference only, no bytes; moving/deleting the file just breaks the link) */
export interface ChatAttachment {
  name: string
  /** Absolute local path (if any) */
  path?: string
  /** Lowercase extension, no dot */
  ext?: string
  sizeBytes?: number
}

// ──────────────────────────────────────────────────────────── Message structures
// ────────────────────────────────────────────────────────────

/** One JSONL line corresponds to one message. */
export interface ChatMessage {
  seq: number
  ts: string
  role: 'user' | 'assistant'
  text: string
  /** File path associated with the message */
  fileRef?: string
  /** Tool activity (with truncated inputs/outputs) */
  tools?: ToolActivity[]
  /** Attachment metadata of a user message */
  attachments?: ChatAttachment[]
}

// ──────────────────────────────────────────────────────────── Project & index structures
// ────────────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface ProjectData extends ProjectInfo {
  files: string[]
}

export interface ProjectIndex {
  projects: ProjectInfo[]
  /** absolute path → projectId */
  fileMap: Record<string, string>
  /** Absolute path → stable chatId (registered on first resolve). */
  chatIdByPath?: Record<string, string>
}

export interface ChatMeta {
  chatId: string
  /** Last modification time of the JSONL file (UTC ISO) */
  updatedAt: string
  /** Approximate line count (estimated from file bytes, not exact) */
  approxCount: number
}

// ──────────────────────────────────────────────────────────── Extended API types (P1)
// ────────────────────────────────────────────────────────────

/** Summary info returned by listProjects() (with aggregated fields) */
export interface ProjectSummary extends ProjectInfo {
  /** Number of files currently belonging to this project */
  fileCount: number
  /** Last active time: max of project.json updatedAt and all chat mtimes */
  lastActiveAt: string
  /** Whether this is the default project (cannot be deleted/renamed) */
  isDefault: boolean
}

/**
 * Project timeline entry: aggregates messages from all chats in a project, sorted by ts descending
 */
export interface TimelineEntry {
  /** Absolute file path (the file this chat belongs to) */
  filePath: string
  /** File name (basename) */
  fileName: string
  /** chat id */
  chatId: string
  /** Message time (UTC ISO) */
  ts: string
  /** Message sender */
  role: 'user' | 'assistant'
  /** First line of the message text (up to 120 chars) */
  preview: string
  /** Message seq within the chat */
  seq: number
}
