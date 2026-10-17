/**
 * Claude Code inside DeepSeek Harness, on the owner's own Claude Code login.
 *
 * Registers the `claude-code` model provider and the Claude step driver.
 * Picking a Claude Code model for a session (in the model picker, or as the
 * default model) makes Claude Code that session's main agent; every other
 * session is untouched. dsh stays the UI, the session store and the phone
 * access. Claude Code runs as the unmodified, officially installed `claude`
 * binary through the official Agent SDK; this plugin never reads, stores or
 * sends a Claude credential.
 *
 * Requires the dsh-agent-loop and dsh-compaction-basic patches in `patches/`.
 *
 * @module dsh-claude-code-provider
 */

import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { ClaudeCodeAdapter } from './adapter.ts'
import { AgentsBridge } from './agents.ts'
import { DshToolBridge } from './bridge.ts'
import { registerClaudeCommands } from './commands.ts'
import { resolveConfig, type Config } from './config.ts'
import { ClaudeStepDriver } from './driver.ts'
import type { Agent, Context } from './dsh-types.ts'
import { canUseToolFor } from './interact.ts'
import { ClaudeCodeRuntime } from './runtime.ts'
import { TaskJobs } from './tasks.ts'

export type { Config } from './config.ts'

export const name = 'dsh-claude-code-provider'
export const inject = ['llm', 'agents']

interface StepDriverRegistry {
  registerStepDriver?(provider: string, driver: ClaudeStepDriver): () => void
}

/** Wire every part together; exported for tests. */
export function createRuntime(ctx: Context, config: Config): { runtime: ClaudeCodeRuntime; driver: ClaudeStepDriver; agents: AgentsBridge; bridge: DshToolBridge; tasks: TaskJobs } {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const runtime = new ClaudeCodeRuntime(ctx, resolveConfig(config, dshHome))
  const bridge = new DshToolBridge(runtime)
  const tasks = new TaskJobs(runtime)
  const agents = new AgentsBridge(ctx, runtime)
  const driver = new ClaudeStepDriver(runtime, {
    startChild: (state, parent, call, signal) => { agents.startChild(state, parent, call, signal) },
    finishChild: (toolUseId) => { agents.finishChild(toolUseId) },
    mirrorStep: (context, toolUseId, self) => agents.mirrorStep(context, toolUseId, self),
    jobIdFor: (state, taskId, ms) => tasks.jobIdFor(state, taskId, ms),
  })
  runtime.wiring = {
    canUseTool: (state, agent) => canUseToolFor(runtime, state, agent),
    mcpServers: (state, agent) => ({ dsh: bridge.server(state, agent) }),
    onSubagentMessage: (state, parent, message) => { agents.onSubagentMessage(state, parent, message) },
    onTask: (state, agent, message) => { tasks.onTask(state, agent, message) },
    onUnsolicited: (_state, agent) => {
      // Give the turn Claude started a dsh turn to show in.
      agent.send(createUserMessage({
        content: [{ type: 'text', text: 'Claude Code continued on its own.' }],
        source: { kind: 'claude-code', form: 'notice', summary: 'Claude Code continued on its own' } as never,
      }), 'next-turn', true)
    },
    onSessionStarted: (state, agent, session) => { registerClaudeCommands(runtime, state, agent, session) },
  }
  return { runtime, driver, agents, bridge, tasks }
}

/**
 * @param ctx - plugin context.
 * @param config - the profile row's config.
 */
export function apply(ctx: Context, config: Config): void {
  const { runtime, driver, agents } = createRuntime(ctx, config)
  const provider = runtime.config.provider
  runtime.log(`provider "${provider}" using ${runtime.config.claudePath} (${runtime.config.auth} auth)`)

  // Test seam for scripted UI tests: a module exporting a fake `query()`. Inert unless set.
  const fake = process.env.DSH_CLAUDE_CODE_FAKE_QUERY
  if (fake !== undefined && fake.length > 0) {
    runtime.warn(`TEST MODE: Claude Code replaced by the scripted fake at ${fake}`)
    void import(fake).then((module: { query: typeof runtime.queryFn }) => { runtime.queryFn = module.query })
  }

  ctx.llm.registerAdapter([provider], new ClaudeCodeAdapter(runtime))

  ctx.inject(['agentLoop'], (loopCtx) => {
    const loop = (loopCtx as unknown as { agentLoop: StepDriverRegistry }).agentLoop
    if (typeof loop.registerStepDriver !== 'function') {
      ctx.logger.error('claude-code: @deepseek-ai/dsh-agent-loop is not patched for step drivers (run scripts/apply-patches.sh from dsh-claude-code-provider); Claude Code sessions cannot run')
      return
    }
    loop.registerStepDriver(provider, driver)
  })

  ctx.inject(['subagents'], (subCtx) => {
    subCtx.subagents.registerProvider(agents.provider() as never)
  })

  // A session moving to another model drops Claude's slash commands.
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    if (config.provider !== provider) runtime.states.get(agent.id)?.commandsDispose?.()
    return config
  })

  // Tell dsh-driven agents what the Claude role tools are for, where they exist.
  ctx.inject(['systemPrompt', 'tools'], (child) => {
    child.systemPrompt.section({
      name: 'claude-code-roles',
      order: child.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
      text: ({ scope }) => {
        const has = (tool: string): boolean => child.tools.get(tool, scope) !== undefined
        const lines: string[] = []
        if (has('claude_agent')) lines.push('- claude_agent: hand a self-contained task to Claude Code as a worker; it can edit and run commands under your permissions.')
        if (has('claude_plan')) lines.push('- claude_plan: have Claude Code investigate read-only and write an implementation plan before you build something non-trivial.')
        if (has('claude_review')) lines.push('- claude_review: have Claude Code review your finished change read-only and report bugs; then fix what it finds.')
        if (lines.length === 0) return ''
        return ['Claude Code subagents are available:', ...lines, 'Give them self-contained prompts (paths, goal, constraints); continue one with send_message.'].join('\n')
      },
    })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') onIdle(ctx, runtime, agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    runtime.dispose(agent.id)
  })

  ctx.effect(() => () => { runtime.closeAll() }, 'claude-code.sessions')
}

/** After a dsh turn: never leave Claude working, and mirror Claude's own compaction into dsh. */
function onIdle(ctx: Context, runtime: ClaudeCodeRuntime, agent: Agent): void {
  const state = runtime.states.get(agent.id)
  const claude = state?.claude
  if (state === undefined || claude === undefined) return
  claude.interrupt()
  if (claude.pendingCompactSummary === undefined || state.mirroringCompaction) return
  // dsh's compaction lives in the agent preset's isolated group; its /compact
  // command is the public way in. Its summary request comes back to the
  // adapter, which answers with Claude's own summary.
  const commands = (agent.ctx.get('commands') ?? ctx.get('commands')) as {
    find(agent: Agent, name: string): unknown
    execute(agent: Agent, line: string, attachments: unknown[], signal: AbortSignal): Promise<unknown>
  } | undefined
  if (commands === undefined || commands.find(agent, 'compact') === undefined) return
  state.mirroringCompaction = true
  setTimeout(() => {
    commands.execute(agent, '/compact', [], AbortSignal.timeout(180_000))
      .catch((error: unknown) => { runtime.warn(`could not mirror Claude's compaction into dsh: ${String(error)}`) })
      .finally(() => { state.mirroringCompaction = false })
  }, 0)
}
