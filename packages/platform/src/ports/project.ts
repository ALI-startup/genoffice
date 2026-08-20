/** Project storage capability (projects, chat history, timeline). */
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
