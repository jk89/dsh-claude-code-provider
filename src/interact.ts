/**
 * Claude Code's interactive moments, answered through dsh's own UI.
 *
 * - Permission prompts → dsh's approval service (the Allow once / Reject card,
 *   in the web UI and DSH Mobile), attached to the tool call's card.
 * - AskUserQuestion → dsh's `ask_user_question` tool (the question card); the
 *   answers go back to Claude.
 * - ExitPlanMode → dsh's `exit_plan_mode` tool (the plan review card): Approve
 *   leaves plan mode in dsh and in Claude; Keep planning returns the feedback.
 * - Tools this plugin serves from dsh over MCP run through dsh's own pipeline,
 *   so Claude's prompt is skipped for them.
 *
 * @module dsh-claude-code-provider/interact
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from './dsh-types.ts'
import type { AgentState, ClaudeCodeRuntime } from './runtime.ts'
import { claudeAnswers, dshQuestions, DSH_MCP_PREFIX, sanitizeToolName, toDshCall } from './toolmap.ts'

/** How long a prompt waits for its tool card to be recorded before asking anyway. */
const CARD_WAIT_MS = 15_000

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
}

export function canUseToolFor(runtime: ClaudeCodeRuntime, state: AgentState, root: Agent): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })
    const id = options.toolUseID
    await state.waitAppended(id, CARD_WAIT_MS)
    const agent = state.toolOwners.get(id) ?? root

    if (toolName.startsWith(DSH_MCP_PREFIX)) return { behavior: 'allow', updatedInput: input }

    try {
      if (toolName === 'AskUserQuestion' && agent.ctx.tools.get('ask_user_question', agent) !== undefined) {
        const result = await runtime.executeDshTool(agent, 'ask_user_question', { questions: dshQuestions(input) }, id, options.signal)
        state.dshResults.set(id, result)
        if (result.isError) return deny(textOf(result.content) || 'The user did not answer.')
        const value = JSON.parse(textOf(result.content)) as { answers?: Array<{ id: string; selected: string[]; custom?: string }> }
        return { behavior: 'allow', updatedInput: { ...input, answers: claudeAnswers(input, value.answers ?? []) } }
      }

      if (toolName === 'ExitPlanMode' && agent.ctx.tools.get('exit_plan_mode', agent) !== undefined) {
        const plan = typeof input.plan === 'string' ? input.plan : ''
        const result = await runtime.executeDshTool(agent, 'exit_plan_mode', { plan }, id, options.signal)
        state.dshResults.set(id, result)
        if (result.isError) return deny(textOf(result.content) || 'The user chose to keep planning.')
        return { behavior: 'allow', updatedInput: input }
      }
    } catch (error: unknown) {
      return deny(`dsh could not ask the user: ${error instanceof Error ? error.message : String(error)}`)
    }

    const approval = agent.ctx.get('approval') ?? runtime.ctx.get('approval')
    if (approval === undefined) return deny('dsh has no approval channel for this session, so the tool call was not approved.')
    const reason = options.title ?? options.description ?? options.decisionReason ?? `Claude Code wants to use ${toolName}`
    try {
      const outcome = await approval.request({
        agent,
        toolName: toDshCall(toolName, input).name || sanitizeToolName(toolName),
        callId: id as never,
        reason,
        signal: options.signal,
      })
      switch (outcome) {
        case 'allowed-once': return { behavior: 'allow', updatedInput: input }
        case 'rejected': return deny('The user rejected this tool call in dsh.')
        case 'cancelled': return deny('The approval request was cancelled.')
        default: return deny('No dsh approval channel answered (the session approval policy may be "never").')
      }
    } catch (error: unknown) {
      return deny(`dsh could not ask for approval: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
