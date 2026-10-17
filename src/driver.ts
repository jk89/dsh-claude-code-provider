/**
 * The Claude Code step driver.
 *
 * Registered on the (patched) dsh agent loop for the `claude-code` route: once
 * a step's route resolves to Claude Code, the loop hands the step here. The
 * loop keeps owning turns, the inbox, steering, cancellation, persistence and
 * crash repair; this driver writes the step's durable events exactly as the
 * loop would — `user/message`, `request/context`, one `assistant/message`
 * (with its live `agent/assistant-stream` frames through the loop's own
 * attempt framing), then `tool/call` / `tool/result` pairs — for one Claude
 * API message per dsh step.
 *
 * @module dsh-claude-code-provider/driver
 */

import { createAssistantMessage, createToolResultMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { Agent, ContentBlock, Message, StreamChunk, UserMessage } from './dsh-types.ts'
import { handoffTranscript, toClaudeContent, type AttachmentPaths } from './content.ts'
import type { AgentState, ClaudeCodeRuntime } from './runtime.ts'
import { SUBAGENT_MODEL_PREFIX } from './runtime.ts'
import type { ClaudeSession, ClaudeUserContent, QueuedMessage } from './session.ts'
import { DSH_MCP_PREFIX, toDshCall, toDshResult, type ClaudeToolOutcome, type DshCall, type DshResult } from './toolmap.ts'
import { MessageTranslator, TASK_TOOLS, type TranslatedToolCall } from './translate.ts'

/** The loop's assistant attempt framing (AssistantStreamAttempt). */
export interface Attempt {
  start(): void
  push(chunk: StreamChunk): void
  settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => number): void
  abandon(): void
  readonly stream: unknown
  blocks(): ContentBlock[]
  interruptedBlocks(): ContentBlock[]
  readonly ended: boolean
}

/** What the patched loop passes to a step driver. */
export interface StepContext {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
  readonly config: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly preparedCall?: { readonly context?: { readonly contextWindow: number }; readonly adapterDefaults?: unknown }
  readonly messages: UserMessage[]
  readonly startsRequestSeries: boolean
  readonly assembly: {
    readonly sections: ReadonlyArray<{ name: string; text: string; interpolate?: boolean }>
    readonly variables: Record<string, string | undefined>
    readonly tools: readonly unknown[]
  }
  createAttempt(): Attempt
  acceptContext(message: UserMessage): void
}

export type StepEnd = { kind: 'completed' } | { kind: 'max-tokens' } | null

/** Sibling services the driver calls into. */
export interface DriverHooks {
  /** Mirror one Claude sub-agent into a dsh child session (Agent tool call recorded). */
  startChild(state: AgentState, parent: Agent, call: TranslatedToolCall, signal: AbortSignal): void
  /** Claude finished the sub-agent behind this Agent tool call. */
  finishChild(toolUseId: string): void
  /** Drive one step of a dsh child that mirrors a Claude sub-agent. */
  mirrorStep(context: StepContext, toolUseId: string, driver: ClaudeStepDriver): Promise<StepEnd>
  /** dsh job id for a Claude background task, once registered. */
  jobIdFor(state: AgentState, taskId: string, ms: number): Promise<string | undefined>
}

/** Sources whose messages are dsh-only and never reach Claude. */
const DSH_ONLY_SOURCES = new Set(['runtime-context', 'repeat-tool-reminder', 'model-selection', 'plan-mode', 'claude-code'])

const PERSONA_SECTIONS = new Set(['deployment:persona-prefix', 'deployment:persona-suffix'])

/** dsh persona sections, rendered, for Claude Code's appended system prompt. */
export function renderPersona(assembly: StepContext['assembly']): string {
  return assembly.sections
    .filter(section => PERSONA_SECTIONS.has(section.name))
    .map(section => section.interpolate === false
      ? section.text
      : section.text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => assembly.variables[name] ?? ''))
    .map(text => text.trim())
    .filter(text => text.length > 0)
    .join('\n\n')
}

export class ClaudeStepDriver {
  /**
   * Claude Code manages its own context and auto-compacts; the plugin mirrors
   * those compactions into dsh. dsh's step-pressure compaction (patched to read
   * this) skips the route: Claude's usage stays high until Claude itself compacts,
   * so dsh compacting its mirror would just re-trigger every step.
   */
  readonly ownsContext = true

  constructor(private readonly runtime: ClaudeCodeRuntime, readonly hooks: DriverHooks) {}

  async step(context: StepContext): Promise<StepEnd> {
    const { agent } = context
    for (const message of context.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    this.logContext(context)

    if (context.config.model.startsWith(SUBAGENT_MODEL_PREFIX)) {
      return this.hooks.mirrorStep(context, context.config.model.slice(SUBAGENT_MODEL_PREFIX.length), this)
    }

    const state = this.runtime.state(agent.id)
    const history = agent.session.deriveMessages() as readonly Message[]
    const claude = await this.runtime.sessionFor({
      agent,
      model: context.config.model,
      reasoningEffort: context.config.reasoningEffort,
      persona: renderPersona(context.assembly),
      history,
    })
    if (claude.streaming) throw new LlmError('Claude Code is already driving this session', 'CLAUDE_CODE_BUSY')
    claude.streaming = true
    try {
      const content = await this.forwardable(claude, state, context, history)
      if (content.length > 0) {
        claude.send(content)
      } else if (!claude.turnActive && !claude.hasQueued) {
        return { kind: 'completed' }
      }
      return await this.consume(claude, state, context)
    } finally {
      claude.streaming = false
    }
  }

  /**
   * Record the route the way the loop does: the request header (compaction,
   * subagent route inheritance and the trajectory read it) and the context
   * facts (model label, context meter).
   */
  private logContext(context: StepContext): void {
    const session = context.agent.session
    const state = this.runtime.state(context.agent.id)
    const header = canonicalHeader({
      config: context.config as never,
      ...context.preparedCall?.adapterDefaults === undefined ? {} : { adapterDefaults: context.preparedCall.adapterDefaults as never },
      ...context.assembly.tools.length > 0 ? { tools: [...context.assembly.tools] as never } : {},
    })
    const baseline = session.requestHeader()
    if (!state.headerLogged) {
      session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      state.headerLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      session.append('request/header', { header, reason: 'change' })
    }
    const contextWindow = context.preparedCall?.context?.contextWindow
    const next = { provider: context.config.provider, model: context.config.model, ...contextWindow === undefined ? {} : { contextWindow } }
    const previous = session.requestContext()
    if (previous?.provider !== next.provider || previous.model !== next.model || previous.contextWindow !== next.contextWindow) {
      session.append('request/context', next)
    }
  }

  /** The step's user input Claude should hear, plus a handoff transcript on a model switch. */
  private async forwardable(
    claude: ClaudeSession,
    state: AgentState,
    context: StepContext,
    history: readonly Message[],
  ): Promise<ClaudeUserContent> {
    const content: ClaudeUserContent = []
    const stepIds = new Set(context.messages.map(message => message.id))
    const earlier = history.filter(message => !stepIds.has(message.id as UserMessage['id']))
    if (claude.fresh) {
      claude.fresh = false
      if (earlier.some(message => message.role === 'assistant')) {
        content.push({
          type: 'text',
          text: '<earlier-conversation note="This dsh session ran on another model before you. Transcript of what happened:">\n'
            + `${handoffTranscript(earlier)}\n</earlier-conversation>`,
        })
      }
    } else {
      // Turns another model ran in this session since Claude last spoke.
      const provider = this.runtime.config.provider
      let last = -1
      earlier.forEach((message, index) => {
        if (message.role === 'assistant' && (message.source as { provider?: string }).provider === provider) last = index
      })
      const missed = earlier.slice(last + 1)
      if (last >= 0 && missed.some(message => message.role === 'assistant')) {
        content.push({
          type: 'text',
          text: '<meanwhile note="Another model handled this dsh session since your last reply. Transcript:">\n'
            + `${handoffTranscript(missed)}\n</meanwhile>`,
        })
      }
    }
    const attachments = (context.agent.ctx.get('attachments') ?? this.runtime.ctx.get('attachments')) as AttachmentPaths | undefined
    for (const message of context.messages) {
      if (claude.forwarded.has(message.id)) continue
      claude.forwarded.add(message.id)
      if (!this.forwards(state, message)) continue
      content.push(...await toClaudeContent(message.content as readonly ContentBlock[], attachments))
    }
    return content
  }

  private forwards(state: AgentState, message: UserMessage): boolean {
    const source = message.source as { kind?: string; senderSessionId?: string }
    const kind = source.kind ?? 'user'
    if (DSH_ONLY_SOURCES.has(kind)) return false
    if (kind === 'subagent-settled' && source.senderSessionId !== undefined && state.ownChildren.has(source.senderSessionId)) return false
    return true
  }

  /** Translate Claude's messages until one assistant message (and its tools) completes. */
  private async consume(claude: ClaudeSession, state: AgentState, context: StepContext): Promise<StepEnd> {
    const translator = new MessageTranslator((call) => {
      if (call.claudeName.startsWith(DSH_MCP_PREFIX)) state.addPendingToolUse(call.id, call.claudeName, call.input)
    }, (claudeName, input) => taskAwareCall(state, claudeName, input))
    let attempt: Attempt | undefined
    const started = (): Attempt => {
      if (attempt === undefined) {
        attempt = context.createAttempt()
        attempt.start()
      }
      return attempt
    }
    try {
      while (true) {
        const message: QueuedMessage = await claude.next(context.signal)
        switch (message.type) {
          case 'dsh-closed':
            this.runtime.forget(state, claude)
            throw new LlmError(`Claude Code stopped: ${message.error?.message ?? 'the process exited'}`, 'CLAUDE_CODE_EXITED')
          case 'result':
            if (attempt !== undefined && !attempt.ended) {
              return await this.settleMessage(claude, state, context, translator, attempt, message)
            }
            return this.finishTurn(message, context)
          case 'system':
            // Claude compacted its own context; dsh mirrors it after the turn.
            continue
          case 'stream_event': {
            const event = message.event as unknown as Record<string, any>
            if (event.type === 'message_start') {
              translator.begin(String(event.message?.id ?? ''), event.message?.usage)
              started()
              continue
            }
            if (event.type === 'message_stop') {
              return await this.settleMessage(claude, state, context, translator, started())
            }
            for (const chunk of translator.event(event)) started().push(chunk)
            continue
          }
          case 'assistant': {
            if (translator.messageId === message.message.id) continue
            // A message that never streamed (API error notices and the like).
            translator.begin(message.message.id, message.message.usage)
            const whole = started()
            for (const chunk of translator.whole(message.message.content as unknown as Record<string, any>[])) whole.push(chunk)
            return await this.settleMessage(claude, state, context, translator, whole)
          }
          default:
            continue
        }
      }
    } catch (error: unknown) {
      if (attempt !== undefined && !attempt.ended) this.settleInterrupted(context, attempt)
      if (context.signal.aborted) claude.interrupt()
      throw error
    }
  }

  /** Commit what the user saw of an interrupted message, like the loop does. */
  private settleInterrupted(context: StepContext, attempt: Attempt): void {
    const { agent, turn, step } = context
    try {
      const content = attempt.interruptedBlocks()
      if (context.signal.aborted && content.length > 0) {
        attempt.settle('assistant/message', () => agent.session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({ content, source: { provider: context.config.provider, model: context.config.model } }),
          interrupted: true,
          stream: attempt.stream as never,
        }, { surfaceOp: 'append' }).seq)
      } else {
        attempt.settle('assistant/attempt', () => agent.session.append('assistant/attempt', { turn, step, stream: attempt.stream as never }).seq)
      }
    } catch {
      if (!attempt.ended) attempt.abandon()
    }
  }

  private async settleMessage(
    claude: ClaudeSession,
    state: AgentState,
    context: StepContext,
    translator: MessageTranslator,
    attempt: Attempt,
    pendingResult?: QueuedMessage,
  ): Promise<StepEnd> {
    const { agent, turn, step } = context
    for (const chunk of translator.finish()) attempt.push(chunk)
    const content = attempt.blocks()
    if (content.length === 0) {
      attempt.settle('assistant/attempt', () => agent.session.append('assistant/attempt', { turn, step, stream: attempt.stream as never }).seq)
    } else {
      const uuid = translator.messageId === undefined ? undefined : claude.uuidFor(translator.messageId)
      const message = createAssistantMessage({
        content,
        source: {
          provider: context.config.provider,
          model: context.config.model,
          replayState: {
            response: {
              claudeSessionId: claude.claudeSessionId ?? '',
              dshSessionId: agent.id,
              ...uuid === undefined ? {} : { uuid },
            },
          },
        },
      })
      attempt.settle('assistant/message', () => agent.session.append('assistant/message', {
        turn,
        step,
        message,
        ...translator.usage === undefined ? {} : { usage: translator.usage },
        stream: attempt.stream as never,
      }, { surfaceOp: 'append' }).seq)
    }

    if (translator.toolCalls.length > 0) {
      await this.runTools(claude, state, context, translator.toolCalls)
      return null
    }
    // No tools: this step ends here; is Claude's turn over too?
    const next = pendingResult ?? await claude.next(context.signal)
    if (next.type === 'result') return this.finishTurn(next, context)
    claude.unshift(next)
    return null
  }

  private finishTurn(message: Extract<QueuedMessage, { type: 'result' }>, context: StepContext): StepEnd {
    if (message.subtype === 'success' && !message.is_error) return { kind: 'completed' }
    if (context.signal.aborted) throw context.signal.reason
    const detail = message.subtype === 'success'
      ? message.result
      : ((message as { errors?: string[] }).errors ?? []).join('; ') || message.subtype
    throw new LlmError(`Claude Code: ${detail}`, `CLAUDE_CODE_${message.subtype.toUpperCase()}`)
  }

  /** Record Claude's tool calls and their results in model order. */
  async runTools(claude: ClaudeSession, state: AgentState, context: StepContext, calls: readonly TranslatedToolCall[]): Promise<void> {
    const { agent, turn, step } = context
    const seqs = calls.map((call) => {
      const seq = agent.session.append('tool/call', { turn, step, callId: call.id as never, name: call.dsh.name, arguments: call.argumentsText }).seq
      state.markAppended(call.id)
      state.toolOwners.set(call.id, agent)
      if (call.dsh.name === 'subagent' && (call.claudeName === 'Agent' || call.claudeName === 'Task')) {
        this.hooks.startChild(state, agent, call, context.signal)
      }
      return seq
    })
    const results = calls.map(call => this.resultFor(claude, state, context, call))
    for (const [index, call] of calls.entries()) {
      const result = await results[index]!
      this.commitResult(context, call, result, seqs[index]!)
    }
  }

  /** Append one tool/result (plus the todo/write a `todo_write` call records). */
  commitResult(context: StepContext, call: TranslatedToolCall, result: DshResult, callSeq: number): void {
    const { agent, turn, step } = context
    if (call.dsh.name === 'todo_write' && !result.isError) {
      try {
        const append = agent.session.append.bind(agent.session) as unknown as (type: string, data: unknown) => void
        append('todo/write', { todos: call.dsh.args.todos })
      } catch {
        // The todo plugin is not composed in this session.
      }
    }
    agent.session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({ callId: call.id as never, content: result.content, isError: result.isError }),
      ...result.error === undefined ? {} : { error: result.error },
      ...result.meta === undefined ? {} : { meta: result.meta as never },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq as never] })
  }

  private async resultFor(claude: ClaudeSession, state: AgentState, context: StepContext, call: TranslatedToolCall): Promise<DshResult> {
    const outcome = await claude.waitToolResult(call.id, context.signal)
    if (TASK_TOOLS.has(call.claudeName) || call.claudeName === 'TaskList') applyTaskResult(state, call, outcome)
    if (call.dsh.name === 'subagent') this.hooks.finishChild(call.id)
    const executed = state.dshResults.get(call.id)
    if (executed !== undefined) {
      state.dshResults.delete(call.id)
      return executed
    }
    return this.mapOutcome(context.agent, state, call, outcome)
  }

  /** Convert Claude's outcome for one call into the dsh result its dsh tool would record. */
  async mapOutcome(agent: Agent, state: AgentState, call: TranslatedToolCall, outcome: ClaudeToolOutcome): Promise<DshResult> {
    const image = call.dsh.name === 'read_image' ? await this.storeImage(agent, outcome) : undefined
    let effective = outcome
    const structured = outcome.structured as { backgroundTaskId?: unknown } | undefined
    if (call.dsh.name === 'bash' && typeof structured?.backgroundTaskId === 'string') {
      const jobId = await this.hooks.jobIdFor(state, structured.backgroundTaskId, 2000)
      if (jobId !== undefined) effective = { ...outcome, structured: { ...structured, backgroundTaskId: jobId } }
    }
    let definition
    try {
      definition = agent.ctx.tools.get(call.dsh.name, agent)
    } catch {
      definition = undefined
    }
    return toDshResult(call.dsh, call.input, effective, definition, image, agent.session.header.cwd)
  }

  /** Store an image Claude read as a durable dsh attachment. */
  private async storeImage(agent: Agent, outcome: ClaudeToolOutcome): Promise<ContentBlock | undefined> {
    const attachments = (agent.ctx.get('attachments') ?? this.runtime.ctx.get('attachments')) as { saveImages?(inputs: unknown[]): Promise<readonly unknown[]> } | undefined
    if (attachments?.saveImages === undefined) return undefined
    const structured = outcome.structured as { file?: { base64?: string; type?: string } } | undefined
    const block = outcome.blocks?.find(entry => entry.type === 'image') as { source?: { data?: string; media_type?: string } } | undefined
    const data = structured?.file?.base64 ?? block?.source?.data
    const mediaType = structured?.file?.type ?? block?.source?.media_type
    if (data === undefined || mediaType === undefined) return undefined
    try {
      const [ref] = await attachments.saveImages([{ data: new Uint8Array(Buffer.from(data, 'base64')), mediaType }])
      return ref === undefined ? undefined : { type: 'image', attachment: ref as never }
    } catch {
      return undefined
    }
  }
}

type TaskStatus = 'pending' | 'in_progress' | 'completed'

/**
 * Claude's task-list tools as dsh `todo_write` calls carrying the whole list
 * after the change, so dsh's todo dock and todo cards follow Claude's plan.
 */
export function taskAwareCall(state: AgentState, claudeName: string, input: Record<string, unknown>): DshCall {
  if (!TASK_TOOLS.has(claudeName)) return toDshCall(claudeName, input)
  const todos = [
    ...[...state.claudeTasks.values()].map(task => ({ ...task })),
    ...state.pendingTaskSubjects.map(content => ({ content, status: 'pending' as const })),
  ]
  if (claudeName === 'TaskCreate' && typeof input.subject === 'string') {
    todos.push({ content: input.subject, status: 'pending' })
    state.pendingTaskSubjects.push(input.subject)
  } else if (claudeName === 'TaskUpdate' && typeof input.taskId === 'string') {
    const ids = [...state.claudeTasks.keys()]
    const index = ids.indexOf(input.taskId)
    if (index >= 0) {
      if (input.status === 'deleted') todos.splice(index, 1)
      else {
        if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') todos[index]!.status = input.status
        if (typeof input.subject === 'string') todos[index]!.content = input.subject
      }
    }
  }
  return { name: 'todo_write', args: { todos }, streamsVerbatim: false }
}

/** Fold one task-tool result into the session's mirrored Claude task list. */
function applyTaskResult(state: AgentState, call: TranslatedToolCall, outcome: ClaudeToolOutcome): void {
  if (outcome.isError) {
    const waiting = state.pendingTaskSubjects.indexOf(String(call.input.subject ?? ''))
    if (call.claudeName === 'TaskCreate' && waiting >= 0) state.pendingTaskSubjects.splice(waiting, 1)
    return
  }
  const structured = (outcome.structured ?? {}) as Record<string, any>
  switch (call.claudeName) {
    case 'TaskCreate': {
      const waiting = state.pendingTaskSubjects.indexOf(String(call.input.subject ?? ''))
      if (waiting >= 0) state.pendingTaskSubjects.splice(waiting, 1)
      const task = structured.task as { id?: string; subject?: string } | undefined
      if (typeof task?.id === 'string') state.claudeTasks.set(task.id, { content: task.subject ?? String(call.input.subject ?? ''), status: 'pending' })
      return
    }
    case 'TaskUpdate': {
      const id = typeof structured.taskId === 'string' ? structured.taskId : call.input.taskId
      if (typeof id !== 'string') return
      if (call.input.status === 'deleted') {
        state.claudeTasks.delete(id)
        return
      }
      const task = state.claudeTasks.get(id)
      if (task === undefined) return
      const status = call.input.status
      if (status === 'pending' || status === 'in_progress' || status === 'completed') task.status = status as TaskStatus
      if (typeof call.input.subject === 'string') task.content = call.input.subject
      return
    }
    case 'TaskList': {
      if (!Array.isArray(structured.tasks)) return
      state.claudeTasks.clear()
      for (const task of structured.tasks as Array<{ id: string; subject: string; status: TaskStatus }>) {
        state.claudeTasks.set(task.id, { content: task.subject, status: task.status })
      }
      return
    }
  }
}
