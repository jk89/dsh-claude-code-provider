/**
 * dsh's own tools for Claude Code, over an in-process MCP server.
 *
 * Claude Code gets every dsh tool visible to its session that it has no native
 * equivalent for — deliverables (`present`), goals, dsh skills, schedules,
 * dsh subagents and `send_message`, jobs, terminals, LSP, session search, … —
 * as `mcp__dsh__<name>`. A call runs through dsh's own tool pipeline (its
 * policies, approvals and rendering) as the Claude-driven agent, under
 * Claude's tool_use id, so the dsh card, result text and metadata are exactly
 * what the dsh tool records for any agent.
 *
 * `delegate_local` hands build work to the configured local model as a dsh
 * continuable subagent (one job at a time); `agent_id` continues one.
 *
 * @module dsh-claude-code-provider/bridge
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { Agent, ContentBlock } from './dsh-types.ts'
import { SerialQueue } from './queue.ts'
import type { AgentState, ClaudeCodeRuntime } from './runtime.ts'
import { DSH_MCP_PREFIX, type DshResult } from './toolmap.ts'

/** dsh tools Claude Code already has natively, or that the plugin maps onto Claude's own. */
const NOT_BRIDGED = new Set([
  'bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'grep', 'glob', 'str_replace_editor',
  'web_search', 'web_fetch', 'todo_write', 'ask_user_question', 'exit_plan_mode', 'run_code',
])

/** dsh shells Claude uses instead of its own Bash in sandboxed dsh modes. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

const DELEGATE_LOCAL = 'delegate_local'

type McpContent = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>

export class DshToolBridge {
  private readonly localQueue = new SerialQueue()

  constructor(private readonly runtime: ClaudeCodeRuntime) {}

  /** dsh tool schemas Claude Code should see for this agent. */
  tools(agent: Agent): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const out: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = []
    let schemas: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> = []
    try {
      schemas = agent.ctx.tools.schemas(agent)
    } catch {
      schemas = []
    }
    const dshShell = this.runtime.usesDshShell(agent)
    for (const schema of schemas) {
      if (NOT_BRIDGED.has(schema.name) && !(dshShell && SHELL_TOOLS.has(schema.name))) continue
      out.push({ name: schema.name, description: schema.description, inputSchema: { type: 'object', ...schema.parameters } })
    }
    const local = this.runtime.config.local
    if (local !== undefined && (agent.ctx.get('subagents') ?? this.runtime.ctx.get('subagents')) !== undefined) {
      out.push({
        name: DELEGATE_LOCAL,
        description: `Hand a self-contained build task to the user's local model (${local.provider}/${local.model}). `
          + 'It runs as a dsh subagent in the same workspace with its own tools and returns its final report plus an agent id. '
          + 'Use it for routine implementation, edits and test runs you have already planned; keep design and review for yourself. '
          + 'The local model sees only what you write, so include paths, the exact change and how to verify it. '
          + 'Pass agent_id to send follow-up work to the same local agent. One local job runs at a time; later calls wait. '
          + 'Check its work afterwards.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The complete task, or the follow-up message when agent_id is given.' },
            context: { type: 'string', description: 'Extra context: relevant files, decisions, constraints.' },
            agent_id: { type: 'string', description: 'Continue this earlier local agent instead of starting a new one.' },
          },
          required: ['task'],
        },
      })
    }
    return out
  }

  /** The MCP server instance for one Claude session. */
  server(state: AgentState, agent: Agent): McpServerConfig {
    const mcp = new McpServer({ name: 'dsh', version: '0.0.1' }, { capabilities: { tools: { listChanged: true } } })
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools(agent) }))
    mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      const meta = request.params._meta as Record<string, unknown> | undefined
      return this.call(state, agent, name, args, meta, extra.signal)
    })
    return { type: 'sdk', name: 'dsh', instance: mcp } as McpServerConfig
  }

  private async call(
    state: AgentState,
    agent: Agent,
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<{ content: McpContent; isError?: boolean }> {
    const claudeName = `${DSH_MCP_PREFIX}${name}`
    const metaId = meta?.['claudecode/toolUseId']
    let id: string | undefined
    if (typeof metaId === 'string') {
      id = metaId
      state.dropToolUse(metaId)
    } else {
      id = await state.claimToolUse(claudeName, args, 30_000)
    }
    id ??= `dsh-${randomUUID()}`
    await state.waitAppended(id, 15_000)
    const owner = state.toolOwners.get(id) ?? agent
    let result: DshResult
    try {
      result = name === DELEGATE_LOCAL
        ? await this.delegateLocal(state, owner, args, signal)
        : await this.runtime.executeDshTool(owner, name, args, id, signal)
    } catch (error: unknown) {
      result = { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
    state.dshResults.set(id, result)
    return { content: await this.mcpContent(owner, result.content), ...result.isError ? { isError: true } : {} }
  }

  private async mcpContent(agent: Agent, content: readonly ContentBlock[]): Promise<McpContent> {
    const out: McpContent = []
    const attachments = (agent.ctx.get('attachments') ?? this.runtime.ctx.get('attachments')) as { imageHostPath?(ref: unknown): string | undefined; fileHostPath?(ref: unknown): string | undefined } | undefined
    for (const block of content) {
      if (block.type === 'text') {
        out.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const path = attachments?.imageHostPath?.(block.attachment)
        try {
          if (path === undefined) throw new Error('no path')
          out.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType: block.attachment.mediaType })
        } catch {
          out.push({ type: 'text', text: `[image${path === undefined ? '' : ` at ${path}`}]` })
        }
      } else if (block.type === 'file') {
        const path = attachments?.fileHostPath?.(block.attachment)
        out.push({ type: 'text', text: `[file "${block.attachment.name}"${path === undefined ? '' : ` at ${path}`}]` })
      }
    }
    if (out.length === 0) out.push({ type: 'text', text: '(no output)' })
    return out
  }

  /** Run (or continue) the local model as a dsh continuable subagent and wait for its report. */
  private delegateLocal(state: AgentState, parent: Agent, args: Record<string, unknown>, signal: AbortSignal): Promise<DshResult> {
    const local = this.runtime.config.local!
    const subagents = (parent.ctx.get('subagents') ?? this.runtime.ctx.get('subagents')) as {
      startContinuable(spec: unknown): Promise<{ childId: string }>
      sendMessage(sender: Agent, targetId: string, content: unknown[], options: { signal: AbortSignal }): Promise<unknown>
    }
    const task = typeof args.task === 'string' ? args.task : ''
    const context = typeof args.context === 'string' && args.context.trim().length > 0 ? `\n\nContext:\n${args.context}` : ''
    const text = `${task}${context}`
    const continueId = typeof args.agent_id === 'string' && args.agent_id.length > 0 ? args.agent_id : undefined
    return this.localQueue.run(async () => {
      let childId: string
      let boundary = 0
      if (continueId !== undefined) {
        childId = continueId
        boundary = this.runtime.agentFor(childId)?.session.seq ?? 0
        await subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal })
      } else {
        const started = await subagents.startContinuable({
          provider: local.subagentProvider ?? 'spawn',
          label: task.split('\n')[0]!.slice(0, 60) || 'Local build task',
          request: {
            prompt: [{ type: 'text', text }],
            parent,
            agentOptions: {
              provider: local.provider,
              model: local.model,
              ...local.reasoningEffort === undefined ? {} : { reasoningEffort: local.reasoningEffort },
            },
            ...local.persona === undefined ? {} : { persona: local.persona },
          },
          signal,
        })
        childId = started.childId
      }
      state.ownChildren.add(childId)
      const child = this.runtime.agentFor(childId)
      if (child === undefined) throw new Error(`local agent ${childId} is not running`)
      const onAbort = (): void => { child.cancel({ kind: 'parent' }) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await child.whenIdle()
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      const events = (child.session as unknown as { snapshotEvents(offset: number): unknown[] }).snapshotEvents(boundary)
      const output = (finalAssistantOutput(events as never) ?? []) as ContentBlock[]
      const report = output
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      return {
        content: [{ type: 'text', text: `${report.length > 0 ? report : '(the local model finished without a report)'}\n\n[local agent id: ${childId} — pass it as agent_id to continue this agent]` }],
        isError: false,
      }
    }, signal)
  }
}
