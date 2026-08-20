import type { AgentSkill } from '@samugen/agent-core'
import basePrompt from './prompts/base.md?raw'
import {
  WORKBOOK_TOOLS,
  buildWorkbookContext,
  executeWorkbookTool,
  type SheetsSkillDeps,
} from './tools'

/**
 * The workbook DSL as an AgentSkill: mirrors createDocsSkill's shape (systemPrompt + tools +
 * buildContext + executeTool) so it plugs into the same packages/agent-core AgentLoop docx uses.
 */
export function createWorkbookSkill(deps: SheetsSkillDeps): AgentSkill {
  return {
    id: 'sheets',
    systemPrompt: basePrompt,
    tools: WORKBOOK_TOOLS,
    buildContext: () => buildWorkbookContext(deps),
    executeTool: (call) => executeWorkbookTool(call, deps),
  }
}
