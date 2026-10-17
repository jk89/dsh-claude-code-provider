/**
 * Process-wide state: one Claude Code conversation per dsh session plus the
 * per-session bookkeeping the step driver, approvals, the dsh tool bridge,
 * background jobs and sub-agent mirroring share.
 *
 * @module dsh-claude-code-provider/runtime
 */

import { join } from 'node:path'
import { query, type EffortLevel, type McpServerConfig, type ModelInfo, type PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { Agent, ContentBlock, Context, JsonValue, Message, ToolCallId } from './dsh-types.ts'
import { childEnv, type ResolvedConfig } from './config.ts'
import { deferred, type Deferred } from './queue.ts'
import { ClaudeSession, type ClaudeSessionKnobs, type ClaudeSessionSpec } from './session.ts'
import { SessionStore } from './store.ts'
import type { DshResult } from './toolmap.ts'

export const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default', description: "Claude Code's own default model" },
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast and capable' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
]

/** Model ids of mirrored Claude sub-agents: `subagent:<parent Agent tool_use id>`. */
export const SUBAGENT_MODEL_PREFIX = 'subagent:'

/** Claude Code tools governed by a dsh tool's visibility in the session. */
const TOOL_GATES: ReadonlyArray<{ dsh: readonly string[]; claude: readonly string[] }> = [
  { dsh: ['bash', 'pwsh'], claude: ['Bash', 'PowerShell', 'Monitor'] },
  { dsh: ['edit', 'write'], claude: ['Edit', 'Write', 'NotebookEdit'] },
  { dsh: ['web_fetch'], claude: ['WebFetch'] },
  { dsh: ['web_search'], claude: ['WebSearch'] },
]

/** Replay facts stored on every Claude-written assistant message. */
export interface ClaudeReplay {
  readonly claudeSessionId: string
  readonly dshSessionId: string
  readonly uuid?: string
}

/** One MCP call waiting to be tied to Claude's tool_use id. */
interface PendingToolUse {
  readonly id: string
  readonly claudeName: string
  readonly argsKey: string
}

/** Per dsh session bookkeeping. */
export class AgentState {
  claude: ClaudeSession | undefined
  /** Results of dsh tools executed on Claude's behalf, by tool_use id. */
  readonly dshResults = new Map<string, DshResult>()
  /** tool_use id → deferred resolved once its dsh tool/call event is recorded. */
  private readonly appended = new Map<string, Deferred<void>>()
  /** tool_use id → the agent whose session shows that call (sub-agent calls live in child sessions). */
  readonly toolOwners = new Map<string, Agent>()
  /** dsh-served MCP tool uses not yet claimed by their MCP call. */
  private readonly pendingToolUses: PendingToolUse[] = []
  private readonly pendingWaiters = new Set<() => void>()
  /** dsh job ids owned by Claude background tasks (their notices are not re-sent to Claude). */
  readonly jobIds = new Set<string>()
  /** Claude task id → dsh job id. */
  readonly jobForTask = new Map<string, string>()
  /** Child sessions whose settlement Claude already learns from its own tool result. */
  readonly ownChildren = new Set<string>()
  /** Agent-scoped dsh commands forwarding to Claude's slash commands. */
  commandsDispose: (() => void) | undefined
  /** Whether a dsh-side compaction mirroring Claude's auto-compaction is running. */
  mirroringCompaction = false
  /** Whether this process has logged a request header for the session (the loop's `requestHeaderLogged`). */
  headerLogged = false
  /** Claude's own task list (TaskCreate/TaskUpdate), mirrored into dsh's todo list. */
  readonly claudeTasks = new Map<string, { content: string; status: 'pending' | 'in_progress' | 'completed' }>()
  /** Subjects of TaskCreate calls recorded but not yet confirmed with a task id, in order. */
  readonly pendingTaskSubjects: string[] = []

  constructor(readonly agentId: string) {}

  markAppended(id: string): void {
    let entry = this.appended.get(id)
    if (entry === undefined) {
      entry = deferred<void>()
      this.appended.set(id, entry)
    }
    entry.resolve()
  }

  /** Wait (bounded) until a tool call's dsh card exists, so prompts attach to it. */
  async waitAppended(id: string, ms: number): Promise<void> {
    let entry = this.appended.get(id)
    if (entry === undefined) {
      entry = deferred<void>()
      this.appended.set(id, entry)
    }
    await Promise.race([entry.promise, new Promise<void>(resolve => setTimeout(resolve, ms).unref())])
  }

  addPendingToolUse(id: string, claudeName: string, input: unknown): void {
    this.pendingToolUses.push({ id, claudeName, argsKey: stableKey(input) })
    for (const wake of [...this.pendingWaiters]) wake()
  }

  /**
   * Claim the tool_use id for one MCP call, waiting briefly for the stream to report it.
   * @returns the tool_use id, or undefined when none matched in time.
   */
  async claimToolUse(claudeName: string, args: unknown, ms: number): Promise<string | undefined> {
    const key = stableKey(args)
    const deadline = Date.now() + ms
    while (true) {
      const exact = this.pendingToolUses.findIndex(entry => entry.claudeName === claudeName && entry.argsKey === key)
      const index = exact >= 0 ? exact : this.pendingToolUses.findIndex(entry => entry.claudeName === claudeName)
      if (index >= 0) return this.pendingToolUses.splice(index, 1)[0]!.id
      const left = deadline - Date.now()
      if (left <= 0) return undefined
      await new Promise<void>((resolve) => {
        const wake = (): void => { this.pendingWaiters.delete(wake); resolve() }
        this.pendingWaiters.add(wake)
        setTimeout(wake, Math.min(left, 250)).unref()
      })
    }
  }

  /** Drop a tool use whose MCP call carried its own id. */
  dropToolUse(id: string): void {
    const index = this.pendingToolUses.findIndex(entry => entry.id === id)
    if (index >= 0) this.pendingToolUses.splice(index, 1)
  }
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What the step driver needs to start or reuse a Claude session. */
export interface SessionRequest {
  readonly agent: Agent
  readonly model: string
  readonly reasoningEffort?: string | undefined
  /** Rendered dsh persona for this agent (appended to Claude Code's system prompt). */
  readonly persona: string
  /** The dsh history visible to this step (for resume, fork and handoff). */
  readonly history: readonly Message[]
}

/** Builders the runtime needs from sibling modules (wired in index.ts). */
export interface RuntimeWiring {
  canUseTool(state: AgentState, agent: Agent): ClaudeSessionSpec['canUseTool']
  mcpServers(state: AgentState, agent: Agent): Record<string, McpServerConfig>
  onSubagentMessage(state: AgentState, parentToolUseId: string, message: unknown): void
  onTask(state: AgentState, agent: Agent, message: unknown): void
  onUnsolicited(state: AgentState, agent: Agent): void
  onSessionStarted(state: AgentState, agent: Agent, session: ClaudeSession): void
}

export class ClaudeCodeRuntime {
  readonly states = new Map<string, AgentState>()
  private modelsCache: Promise<ModelInfo[]> | undefined
  private readonly store: SessionStore
  wiring!: RuntimeWiring
  /** Test seam: replaces the SDK `query()` for every session. */
  queryFn: typeof query | undefined

  constructor(readonly ctx: Context, readonly config: ResolvedConfig) {
    this.store = new SessionStore(join(config.stateDir, 'sessions.json'), message => this.log(message))
  }

  log(message: string): void {
    this.ctx.logger.info(`claude-code: ${message}`)
  }

  warn(message: string): void {
    this.ctx.logger.warn(`claude-code: ${message}`)
  }

  state(agentId: string): AgentState {
    let state = this.states.get(agentId)
    if (state === undefined) {
      state = new AgentState(agentId)
      this.states.set(agentId, state)
    }
    return state
  }

  agentFor(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(sessionId as Agent['id'])
  }

  /** Models the installed binary offers (asked once, no prompt sent). */
  models(): Promise<ModelInfo[]> {
    this.modelsCache ??= (async () => {
      async function* idle(): AsyncGenerator<never> { await new Promise(() => {}) }
      const probe = (this.queryFn ?? query)({
        prompt: idle(),
        options: {
          pathToClaudeCodeExecutable: this.config.claudePath,
          env: childEnv(this.config),
          permissionMode: 'default',
          persistSession: false,
        },
      })
      try {
        const models = await probe.supportedModels()
        const shown = this.config.allModels ? models : models.filter(model => !/\d/.test(model.value))
        return shown.length > 0 ? shown : FALLBACK_MODELS
      } catch (error: unknown) {
        this.warn(`model list unavailable, using defaults: ${String(error)}`)
        this.modelsCache = undefined
        return FALLBACK_MODELS
      } finally {
        probe.close()
      }
    })()
    return this.modelsCache
  }

  /** Whether dsh plan mode is active for this agent (the plan-mode plugin's durable `plan` projection). */
  planActive(agent: Agent): boolean {
    try {
      const projections = (agent.ctx.get('sessionProjections') ?? this.ctx.get('sessionProjections')) as { stateOf(session: unknown, key: string): unknown } | undefined
      const state = projections?.stateOf(agent.session, 'plan') as { active?: boolean } | undefined
      return state?.active === true
    } catch {
      return false
    }
  }

  /**
   * dsh's own permission state for one agent, the way dsh's tools see it: the
   * effective sandbox mode, the approval policy (`never` for delegated
   * children), the named preset, and whether a confining shell exists.
   */
  dshPermissions(agent: Agent): { sandbox: string | undefined; approval: string; preset: string | undefined; confiningShell: boolean } {
    const get = (name: string): any => agent.ctx.get(name as never) ?? this.ctx.get(name as never)
    let sandbox: string | undefined
    let approval = 'ask'
    let preset: string | undefined
    try {
      sandbox = get('sandboxPolicy')?.resolve({ session: agent.session }).mode
    } catch {
      sandbox = undefined
    }
    try {
      const service = get('approval')
      approval = service?.overrideOf(agent.session) ?? service?.config?.policy ?? 'ask'
    } catch {
      approval = 'ask'
    }
    try {
      preset = get('permissionPresets')?.current(agent.session)
    } catch {
      preset = undefined
    }
    const confiningShell = get('shell')?.sandboxMode !== undefined
    return { sandbox, approval, preset, confiningShell }
  }

  /**
   * Whether Claude's shell commands run through dsh's own sandboxed `bash`
   * (sandboxed dsh modes), rather than Claude Code's Bash (full access).
   */
  usesDshShell(agent: Agent): boolean {
    if (this.config.permissionMode !== 'follow-dsh') return false
    const { sandbox, preset, confiningShell } = this.dshPermissions(agent)
    if (!confiningShell || preset === 'auto') return false
    if (sandbox !== 'workspace-write' && sandbox !== 'read-only') return false
    try {
      return agent.ctx.tools.get('bash', agent) !== undefined || agent.ctx.tools.get('pwsh', agent) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Claude permission mode for one agent right now, following dsh: plan mode;
   * the Auto preset; then the sandbox mode the session (or, for a subagent,
   * its parent) runs under. Anything Claude would still ask about goes to
   * dsh's approval service, which refuses it for delegated children (approval
   * policy "never") exactly as it does for dsh's own subagents.
   */
  permissionModeFor(agent: Agent): PermissionMode {
    if (this.planActive(agent)) return 'plan'
    const setting = this.config.permissionMode
    if (setting !== 'follow-dsh') return setting
    const { sandbox, preset } = this.dshPermissions(agent)
    if (preset === 'auto') return 'auto'
    switch (sandbox) {
      case 'danger-full-access': return this.config.allowBypass ? 'bypassPermissions' : 'auto'
      case 'workspace-write': return 'acceptEdits'
      default: return 'default'
    }
  }

  /** Claude tools hidden because the matching dsh tools are not visible to this agent. */
  disallowedToolsFor(agent: Agent): string[] {
    const out = new Set(this.config.disallowedTools)
    const visible = (name: string): boolean => {
      try {
        return agent.ctx.tools.get(name, agent) !== undefined
      } catch {
        return true
      }
    }
    for (const gate of TOOL_GATES) {
      if (!gate.dsh.some(visible)) for (const name of gate.claude) out.add(name)
    }
    // Sandboxed dsh modes: shell commands go through dsh's sandboxed bash instead.
    if (this.usesDshShell(agent)) for (const name of ['Bash', 'PowerShell', 'Monitor']) out.add(name)
    if (!visible('exit_plan_mode')) out.add('ExitPlanMode')
    if (!visible('ask_user_question')) out.add('AskUserQuestion')
    return [...out].sort()
  }

  knobsFor(agent: Agent, model: string, reasoningEffort: string | undefined): ClaudeSessionKnobs {
    const effort = EFFORTS.includes(reasoningEffort as EffortLevel) ? reasoningEffort as EffortLevel : undefined
    return {
      ...model === 'default' ? {} : { model },
      ...effort === undefined ? {} : { effort },
      permissionMode: this.permissionModeFor(agent),
    }
  }

  /**
   * The live Claude conversation for one dsh session, created, resumed or
   * forked on demand, with the step's model, effort and permissions applied.
   */
  async sessionFor(request: SessionRequest): Promise<ClaudeSession> {
    const { agent } = request
    const state = this.state(agent.id)
    const knobs = this.knobsFor(agent, request.model, request.reasoningEffort)
    const disallowedTools = this.disallowedToolsFor(agent)
    const staticKey = JSON.stringify({ persona: request.persona, disallowedTools })

    let session = state.claude
    if (session !== undefined && (session.isClosed || (session.staticKey !== staticKey && !session.turnActive))) {
      this.forget(state, session)
      session = undefined
    }
    if (session !== undefined) {
      try {
        await session.apply(knobs)
      } catch (error: unknown) {
        this.warn(`could not apply model/effort/permission change: ${String(error)}`)
      }
      return session
    }

    const cwd = agent.session.header.cwd ?? process.cwd()
    const replay = latestReplay(request.history, this.config.provider)
    const stored = this.store.get(agent.id)
    let resume: string | undefined
    let fork = false
    let forkAt: string | undefined
    if (replay !== undefined && replay.dshSessionId === agent.id) {
      resume = replay.claudeSessionId
    } else if (replay !== undefined) {
      // History copied from another dsh session (a dsh fork): fork Claude at the same point.
      resume = replay.claudeSessionId
      fork = true
      forkAt = replay.uuid
    } else if (stored !== undefined && stored.cwd === cwd) {
      resume = stored.claudeSessionId
    }

    session = new ClaudeSession({
      dshSessionId: agent.id,
      cwd,
      executable: this.config.claudePath,
      ...resume === undefined ? {} : { resume },
      ...fork ? { forkSession: true } : {},
      ...forkAt === undefined ? {} : { resumeSessionAt: forkAt },
      ...knobs,
      allowBypass: this.config.allowBypass,
      ...request.persona.length > 0 ? { appendSystemPrompt: request.persona } : {},
      disallowedTools,
      mcpServers: this.wiring.mcpServers(state, agent),
      env: childEnv(this.config),
      canUseTool: this.wiring.canUseTool(state, agent),
      onClaudeSessionId: (claudeSessionId) => { this.store.set(agent.id, claudeSessionId, cwd) },
      onSubagentMessage: (parent, message) => { this.wiring.onSubagentMessage(state, parent, message) },
      onTask: (message) => { this.wiring.onTask(state, agent, message) },
      onUnsolicited: () => { this.wiring.onUnsolicited(state, agent) },
      log: message => this.log(message),
      ...this.queryFn === undefined ? {} : { queryFn: this.queryFn },
    }, staticKey)
    state.claude = session
    const how = resume === undefined ? 'started a new Claude session' : fork ? `forked Claude session ${resume}` : `resumed Claude session ${resume}`
    this.log(`${how} for dsh session ${agent.id} (permission ${knobs.permissionMode})`)
    this.wiring.onSessionStarted(state, agent, session)
    return session
  }

  /** Drop a dead or replaced conversation; a failed resume is not retried. */
  forget(state: AgentState, session: ClaudeSession): void {
    if (state.claude === session) state.claude = undefined
    if (!session.initialized && session.resumedFrom !== undefined) {
      this.warn(`could not resume Claude session ${session.resumedFrom}; the next turn starts a new one`)
      this.store.delete(state.agentId)
    }
    session.close()
  }

  /** Close everything belonging to one dsh session (agent disposed). */
  dispose(agentId: string): void {
    const state = this.states.get(agentId)
    if (state === undefined) return
    state.claude?.close()
    state.claude = undefined
    state.commandsDispose?.()
    this.states.delete(agentId)
  }

  closeAll(): void {
    for (const state of this.states.values()) state.claude?.close()
    this.states.clear()
  }

  /**
   * Run one dsh tool on an agent's behalf, as that agent, through dsh's own
   * tool pipeline (policies, approvals, rendering), under Claude's call id.
   */
  async executeDshTool(agent: Agent, name: string, args: unknown, callId: string, signal: AbortSignal): Promise<DshResult> {
    const result = await this.ctx.agents.withInitiator(agent, () => agent.ctx.tools.execute({
      callId: callId as ToolCallId,
      name,
      arguments: args,
      agent,
      signal,
    }))
    const raw = result as unknown as { content: ContentBlock[]; isError?: boolean; meta?: JsonValue; error?: { info?: { name: string; code: string; reason?: string } } }
    return {
      content: raw.content,
      isError: raw.isError === true,
      ...raw.meta === undefined ? {} : { meta: raw.meta },
      ...raw.error?.info === undefined ? {} : { error: raw.error.info },
    }
  }
}

/** The latest Claude replay record in a dsh history. */
export function latestReplay(history: readonly Message[], provider: string): ClaudeReplay | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!
    if (message.role !== 'assistant') continue
    const source = message.source as { provider?: string; replayState?: { response?: unknown } }
    if (source.provider !== provider) continue
    const response = source.replayState?.response as Partial<ClaudeReplay> | undefined
    if (typeof response?.claudeSessionId === 'string' && typeof response.dshSessionId === 'string') {
      return {
        claudeSessionId: response.claudeSessionId,
        dshSessionId: response.dshSessionId,
        ...typeof response.uuid === 'string' ? { uuid: response.uuid } : {},
      }
    }
  }
  return undefined
}
