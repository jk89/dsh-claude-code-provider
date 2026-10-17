/**
 * One live Claude Code conversation bound to one dsh session.
 *
 * The official Agent SDK `query()` runs in streaming-input mode against the
 * installed `claude` binary and stays alive across dsh turns. A pump routes
 * every SDK message:
 *
 * - main-thread stream events and assistant frames go to the step driver;
 * - main-thread tool results settle the dsh tool calls waiting for them;
 * - sub-agent traffic (Claude's own Agent tool) goes to the dsh child session
 *   that mirrors that sub-agent;
 * - background-task events go to the dsh job registry bridge;
 * - turns this plugin started for itself (`/compact`) and turns abandoned by an
 *   interrupt are dropped.
 *
 * @module dsh-claude-code-provider/session
 */

import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import { abortable, deferred, PushQueue, type Deferred } from './queue.ts'
import type { ClaudeToolOutcome } from './toolmap.ts'

/** Everything fixed when the Claude process starts. */
export interface ClaudeSessionSpec {
  /** dsh session id this conversation belongs to. */
  readonly dshSessionId: string
  /** Workspace directory (the dsh session cwd). */
  readonly cwd: string
  /** Installed, unmodified `claude` binary. */
  readonly executable: string
  /** Claude session to resume. */
  readonly resume?: string
  /** Fork the resumed session instead of continuing it (dsh fork). */
  readonly forkSession?: boolean
  /** Resume only up to this message uuid (dsh fork point). */
  readonly resumeSessionAt?: string
  readonly model?: string
  readonly effort?: EffortLevel
  readonly permissionMode: PermissionMode
  /** Launch with bypass available so the permission mapping can switch to it. */
  readonly allowBypass: boolean
  /** Text appended to Claude Code's own system prompt (dsh persona / role). */
  readonly appendSystemPrompt?: string
  readonly disallowedTools: readonly string[]
  readonly mcpServers: Record<string, McpServerConfig>
  /** Environment for the binary; credential values are never read. */
  readonly env: Record<string, string | undefined>
  readonly canUseTool: CanUseTool
  readonly onClaudeSessionId: (claudeSessionId: string) => void
  /** Claude sub-agent traffic, keyed by the parent Agent tool_use id. */
  readonly onSubagentMessage: (parentToolUseId: string, message: SDKMessage) => void
  /** Background-task lifecycle messages. */
  readonly onTask: (message: SDKMessage) => void
  /** Claude started a turn of its own while dsh was idle (e.g. after a background task). */
  readonly onUnsolicited: () => void
  readonly log: (message: string) => void
  /** Test seam: replaces the SDK `query()`. */
  readonly queryFn?: typeof query
}

/** Mutable per-step knobs applied to a running query. */
export interface ClaudeSessionKnobs {
  readonly model?: string
  readonly effort?: EffortLevel
  readonly permissionMode: PermissionMode
}

/** Messages handed to the step driver. */
export type QueuedMessage = SDKMessage | { type: 'dsh-closed'; error?: Error }

/** Content accepted by one streamed user message. */
export type ClaudeUserContent = Extract<SDKUserMessage['message']['content'], unknown[]>

type Stamped = { user_message_uuid?: string; user_message_uuids?: string[] }

function stampOf(message: SDKMessage): string[] | undefined {
  const stamped = message as Stamped
  if (stamped.user_message_uuids !== undefined && stamped.user_message_uuids.length > 0) return stamped.user_message_uuids
  if (stamped.user_message_uuid !== undefined) return [stamped.user_message_uuid]
  return undefined
}

export class ClaudeSession {
  readonly dshSessionId: string
  /** Claude's session id (changes after a fork-resume reports its new id). */
  claudeSessionId: string | undefined
  readonly resumedFrom: string | undefined
  /** Whether the binary reported its session (it started successfully). */
  initialized = false
  /** A new Claude conversation that has not received its first input yet. */
  fresh: boolean
  /** Whether a step driver is consuming this session right now. */
  streaming = false
  /** Static options this process was started with; a change restarts it. */
  readonly staticKey: string
  /** Claude's own summary of its latest auto-compaction, not yet mirrored into dsh. */
  pendingCompactSummary: string | undefined
  /** dsh message ids already delivered to Claude. */
  readonly forwarded = new Set<string>()
  private readonly query: Query
  private readonly input = new PushQueue<SDKUserMessage>()
  private readonly queue: QueuedMessage[] = []
  private queueWaiter: (() => void) | undefined
  private readonly toolResults = new Map<string, ClaudeToolOutcome>()
  private readonly toolWaiters = new Map<string, Deferred<ClaudeToolOutcome>>()
  /** Sends Claude has not yet answered with a `result`. */
  private readonly unconsumed = new Set<string>()
  /** Sends whose frames are dropped (interrupted, or internal like /compact). */
  private readonly dropped = new Set<string>()
  /** Whether the turn now streaming belongs to dropped sends. */
  private dropping = false
  /** Latest message uuid per Claude API message id (for fork/resume points). */
  private readonly uuidByMessage = new Map<string, string>()
  private compactWaiter: Deferred<string> | undefined
  /** Whether the current unsolicited Claude turn was already announced to dsh. */
  private unsolicitedAnnounced = false
  /** Send id of an internal /compact turn still running. */
  private internalCompact: string | undefined
  private knobs: ClaudeSessionKnobs
  private closedError: Error | undefined
  private closed = false
  private readonly log: (message: string) => void

  constructor(private readonly spec: ClaudeSessionSpec, staticKey: string) {
    this.dshSessionId = spec.dshSessionId
    this.claudeSessionId = spec.forkSession === true ? undefined : spec.resume
    this.resumedFrom = spec.resume
    this.fresh = spec.resume === undefined
    this.staticKey = staticKey
    this.log = spec.log
    this.knobs = {
      ...spec.model === undefined ? {} : { model: spec.model },
      ...spec.effort === undefined ? {} : { effort: spec.effort },
      permissionMode: spec.permissionMode,
    }
    const options: Options = {
      cwd: spec.cwd,
      pathToClaudeCodeExecutable: spec.executable,
      env: spec.env,
      includePartialMessages: true,
      forwardSubagentText: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      permissionMode: spec.permissionMode,
      ...spec.allowBypass ? { allowDangerouslySkipPermissions: true } : {},
      canUseTool: spec.canUseTool,
      disallowedTools: [...spec.disallowedTools],
      mcpServers: spec.mcpServers,
      systemPrompt: spec.appendSystemPrompt === undefined || spec.appendSystemPrompt.length === 0
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt },
      hooks: {
        PostCompact: [{
          hooks: [async (input) => {
            const summary = (input as { compact_summary?: string }).compact_summary ?? ''
            if (this.compactWaiter !== undefined) {
              this.compactWaiter.resolve(summary)
              this.compactWaiter = undefined
            } else {
              this.pendingCompactSummary = summary
            }
            return {}
          }],
        }],
      },
      ...spec.model === undefined ? {} : { model: spec.model },
      ...spec.effort === undefined ? {} : { effort: spec.effort },
      ...spec.resume === undefined ? {} : { resume: spec.resume },
      ...spec.forkSession === true ? { forkSession: true } : {},
      ...spec.resumeSessionAt === undefined ? {} : { resumeSessionAt: spec.resumeSessionAt },
      stderr: (data: string) => { this.log(`claude stderr: ${data.trimEnd()}`) },
    }
    this.query = (spec.queryFn ?? query)({ prompt: this.input, options })
    void this.pump()
  }

  /** Whether Claude is inside a turn (some send not yet answered by a result). */
  get turnActive(): boolean {
    return [...this.unconsumed].some(uuid => !this.dropped.has(uuid))
  }

  get isClosed(): boolean {
    return this.closed
  }

  get hasQueued(): boolean {
    return this.queue.length > 0
  }

  /** Message uuid to resume or fork at, for one Claude API message. */
  uuidFor(messageId: string): string | undefined {
    return this.uuidByMessage.get(messageId)
  }

  /**
   * Bring the running query to the requested model, effort and permission mode.
   * @param next - the knobs the current dsh step asks for.
   */
  async apply(next: ClaudeSessionKnobs): Promise<void> {
    if (next.model !== this.knobs.model) await this.query.setModel(next.model)
    if (next.effort !== this.knobs.effort) await this.query.applyFlagSettings({ effortLevel: next.effort ?? null })
    if (next.permissionMode !== this.knobs.permissionMode) await this.query.setPermissionMode(next.permissionMode)
    this.knobs = next
  }

  /**
   * Deliver user content. While Claude is mid-turn this is a steer: Claude
   * Code folds it into the running turn at its next boundary.
   */
  send(content: ClaudeUserContent | string): void {
    this.push(content, false)
  }

  /** Ask Claude Code to compact its context; resolves with Claude's summary. */
  compact(signal: AbortSignal | undefined): Promise<string> {
    const waiter = deferred<string>()
    this.compactWaiter = waiter
    this.internalCompact = this.push('/compact', true)
    return abortable(waiter.promise, signal).finally(() => {
      if (this.compactWaiter === waiter) this.compactWaiter = undefined
    })
  }

  supportedCommands(): Promise<SlashCommand[]> {
    return this.query.supportedCommands()
  }

  stopTask(taskId: string): Promise<void> {
    return this.query.stopTask(taskId)
  }

  private push(content: ClaudeUserContent | string, internal: boolean): string {
    if (this.closed) throw this.closedError ?? new Error('Claude Code session is closed')
    const uuid = randomUUID()
    this.unconsumed.add(uuid)
    if (internal) this.dropped.add(uuid)
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage)
    return uuid
  }

  /**
   * Next main-thread message for the step driver.
   * @param signal - the dsh step signal.
   */
  async next(signal: AbortSignal | undefined): Promise<QueuedMessage> {
    while (true) {
      const message = this.queue.shift()
      if (message !== undefined) return message
      if (this.closed) return { type: 'dsh-closed', ...this.closedError === undefined ? {} : { error: this.closedError } }
      await abortable(new Promise<void>((resolve) => { this.queueWaiter = resolve }), signal)
      this.queueWaiter = undefined
    }
  }

  /** Return a message to the front of the queue (peeked but not consumed). */
  unshift(message: QueuedMessage): void {
    this.queue.unshift(message)
  }

  /**
   * Wait for Claude's own result of one main-thread tool call.
   * @param toolUseId - Claude tool_use id (also the dsh tool call id).
   * @param signal - the dsh step signal.
   */
  waitToolResult(toolUseId: string, signal: AbortSignal | undefined): Promise<ClaudeToolOutcome> {
    const ready = this.toolResults.get(toolUseId)
    if (ready !== undefined) {
      this.toolResults.delete(toolUseId)
      return Promise.resolve(ready)
    }
    if (this.closed) return Promise.reject(this.closedError ?? new Error('Claude Code session is closed'))
    let waiter = this.toolWaiters.get(toolUseId)
    if (waiter === undefined) {
      waiter = deferred<ClaudeToolOutcome>()
      this.toolWaiters.set(toolUseId, waiter)
    }
    return abortable(waiter.promise, signal)
  }

  /** Stop Claude's current turn (dsh cancel). Idempotent while the turn winds down. */
  interrupt(): void {
    if (this.closed || !this.turnActive) return
    for (const uuid of this.unconsumed) this.dropped.add(uuid)
    this.dropping = true
    this.queue.length = 0
    this.log(`interrupting Claude turn (dsh session ${this.dshSessionId})`)
    this.query.interrupt().catch((error: unknown) => {
      this.log(`interrupt failed: ${String(error)}`)
    })
  }

  close(): void {
    if (this.closed) return
    this.markClosed(undefined)
    this.input.end()
    try {
      this.query.close()
    } catch {
      // Already gone.
    }
  }

  private markClosed(error: Error | undefined): void {
    this.closed = true
    this.closedError = error
    const failure = error ?? new Error('Claude Code session closed')
    for (const waiter of this.toolWaiters.values()) waiter.reject(failure)
    this.toolWaiters.clear()
    this.compactWaiter?.reject(failure)
    this.compactWaiter = undefined
    this.unconsumed.clear()
    this.queueWaiter?.()
  }

  private enqueue(message: QueuedMessage): void {
    this.queue.push(message)
    this.queueWaiter?.()
    // Frames nobody asked for while dsh is idle: Claude continued on its own.
    if (message.type !== 'result' && !this.streaming && this.unconsumed.size === 0 && !this.unsolicitedAnnounced) {
      this.unsolicitedAnnounced = true
      this.spec.onUnsolicited()
    }
  }

  private settleTool(toolUseId: string, outcome: ClaudeToolOutcome): void {
    const waiter = this.toolWaiters.get(toolUseId)
    if (waiter !== undefined) {
      this.toolWaiters.delete(toolUseId)
      waiter.resolve(outcome)
    } else {
      this.toolResults.set(toolUseId, outcome)
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) this.route(message)
      this.markClosed(undefined)
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!this.closed) this.log(`Claude Code process failed: ${failure.message}`)
      this.markClosed(failure)
    }
    this.queueWaiter?.()
  }

  private route(message: SDKMessage): void {
    if (message.type === 'system') {
      switch (message.subtype) {
        case 'init':
          this.initialized = true
          if (message.session_id !== this.claudeSessionId) {
            this.claudeSessionId = message.session_id
            this.spec.onClaudeSessionId(message.session_id)
          }
          return
        case 'task_started':
        case 'task_progress':
        case 'task_notification':
        case 'task_updated':
          this.spec.onTask(message)
          return
        default:
          break
      }
    }

    const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
    if (parent !== null && parent !== undefined) {
      // Sub-agent traffic: complete frames go to the mirrored dsh child.
      if (message.type === 'assistant' || message.type === 'user') this.spec.onSubagentMessage(parent, message)
      return
    }

    if (message.type === 'user') {
      if ('isReplay' in message && message.isReplay === true) return
      const content = message.message.content
      if (!Array.isArray(content)) return
      for (const block of content as unknown as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        this.settleTool(block.tool_use_id, {
          text: toolResultText(block.content),
          isError: block.is_error === true,
          structured: (message as { tool_use_result?: unknown }).tool_use_result,
          blocks: Array.isArray(block.content) ? block.content as Record<string, unknown>[] : [],
        })
      }
      return
    }

    if (message.type === 'result') {
      const consumed = stampOf(message) ?? [...this.unconsumed]
      const allDropped = consumed.length > 0 && consumed.every(uuid => this.dropped.has(uuid))
      for (const uuid of consumed) {
        this.unconsumed.delete(uuid)
        this.dropped.delete(uuid)
        if (uuid === this.internalCompact) {
          this.internalCompact = undefined
          // Claude answered /compact without compacting ("Not enough messages to compact.").
          if (this.compactWaiter !== undefined) {
            const said = message.subtype === 'success' ? message.result.trim() : ''
            this.compactWaiter.reject(new Error(`Claude Code did not compact${said.length > 0 ? `: ${said}` : ''}`))
            this.compactWaiter = undefined
          }
        }
      }
      if (consumed.length === 0) this.unconsumed.clear()
      for (const [id, waiter] of this.toolWaiters) {
        waiter.reject(new Error('Claude Code ended its turn without reporting this tool result'))
        this.toolWaiters.delete(id)
      }
      const wasDropping = this.dropping
      this.dropping = false
      this.unsolicitedAnnounced = false
      if (allDropped || (wasDropping && consumed.length === 0)) return
      this.enqueue(message)
      return
    }

    // Our own /compact reports through the PostCompact hook, not the step stream.
    if (message.type === 'system' && message.subtype === 'compact_boundary' && this.internalCompact !== undefined) return

    // A stamped frame tells whose turn is streaming now.
    const stamp = stampOf(message)
    if (stamp !== undefined) this.dropping = stamp.every(uuid => this.dropped.has(uuid))
    if (this.dropping) return

    if (message.type === 'assistant') {
      this.uuidByMessage.set(message.message.id, message.uuid)
      this.enqueue(message)
      return
    }
    if (message.type === 'stream_event') {
      this.enqueue(message)
      return
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') this.enqueue(message)
  }
}

/** Flatten tool_result content to text; images and documents become short markers. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  const parts: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'document') parts.push('[document]')
    else parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}
