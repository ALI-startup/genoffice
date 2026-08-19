/**
 * Project storage capability (projects, chat history, timeline).
 *
 * The canonical surface already lives in @samugen/project-store as
 * `ProjectApi` and is transport-agnostic (no Electron import), so the port is
 * an alias rather than a re-declaration — one definition, no drift.
 *
 * Note: apps/shell's ProjectHomeApi covers the same domain with a flatter,
 * positional-argument shape (createProject(name) instead of
 * createProject({ name })). ProjectApi is the canonical one: it is the contract
 * the store itself implements, and the shell shape is a thin UI adapter.
 */
import type { ProjectApi } from '@samugen/project-store'

export type {
  AppendChatArgs,
  ChatMessage,
  LoadChatArgs,
  ProjectSummary,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
  TimelineEntry,
} from '@samugen/project-store'

export type ProjectPort = ProjectApi
