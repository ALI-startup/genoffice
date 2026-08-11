import type { Editor } from '@tiptap/core'
import type { AgentSkill } from '@genoffice/agent-core'
import { AGENT_SYSTEM_PROMPT, buildDocContext, type AiTrack, type NumIds } from './protocol'
import { AGENT_TOOLS, executeTool, markDocSeen } from './tools'
import type { AgentToolDef } from '../../shared/ipc'

/**
 * The docx capability as an AgentSkill: document skeleton context, the five
 * document tools, and the local executor. Future apps register their own
 * skills (Excel / PPT) against the same agent loop.
 */
/**
 * @param tools which tool definitions to offer the model. The app passes
 *   `availableTools()`, which drops the search-backed tools on a host with no
 *   `SearchPort` so the model is never offered a capability that would fail. The
 *   default is the full catalogue, for callers (tests) that exercise the skill
 *   without a host installed.
 */
export function createDocsSkill(
  getEditor: () => Editor,
  getNumIds: () => NumIds,
  getTrack?: () => AiTrack | undefined,
  tools: AgentToolDef[] = AGENT_TOOLS,
): AgentSkill {
  return {
    id: 'docx',
    systemPrompt: AGENT_SYSTEM_PROMPT,
    tools,
    buildContext: () => {
      const editor = getEditor()
      markDocSeen(editor) // the context the model receives is the freshness baseline for index-addressed writes
      return buildDocContext(editor)
    },
    executeTool: (call, signal) =>
      executeTool(getEditor(), call, getNumIds(), getTrack?.(), signal),
  }
}
