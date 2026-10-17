/**
 * Claude Code sub-agents (its Agent tool) as dsh child sessions.
 *
 * When Claude calls its Agent tool, the parent's dsh `subagent` card is
 * recorded and a real dsh child is started through dsh's subagent service
 * (provider `claude-code-agent`, dsh's own in-process run driver). The child
 * appears in the sidebar tree and the subagent panel like any dsh subagent.
 * Its route is `claude-code` / `subagent:<Agent tool_use id>`, so every child
 * step comes back to the Claude step driver, which replays that sub-agent's
 * frames (forwarded by the SDK with `parent_tool_use_id`) into the child
 * session: assistant messages, tool cards and results. Nested sub-agents
 * nest the same way.
 *
 * @module dsh-claude-code-provider/agents
 */

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { Agent, Context } from './dsh-types.ts'
import type { ClaudeStepDriver, StepContext, StepEnd } from './driver.ts'
import { deferred, type Deferred } from './queue.ts'
import type { AgentState, ClaudeCodeRuntime } from './runtime.ts'
import { SUBAGENT_MODEL_PREFIX } from './runtime.ts'
import { toolResultText } from './session.ts'
import type { ClaudeToolOutcome } from './toolmap.ts'
import { MessageTranslator, type TranslatedToolCall } from './translate.ts'

export const SUBAGENT_PROVIDER = 'claude-code-agent'

type Frame = Record<string, any>

/** Ordered frames of one Claude sub-agent, consumed by its dsh child. */
class Feed {
  private readonly items: Frame[] = []
  private waiter: Deferred<void> | undefined
  finished = false
  /** Root dsh agent state (approvals for the sub-agent's tools are routed through it). */
  constructor(readonly root: AgentState) {}

  push(frame: Frame): void {
    this.items.push(frame)
    this.waiter?.resolve()
  }

  finish(): void {
    this.finished = true
    this.waiter?.resolve()
  }

  /** Remove and return the first frame matching `pick`, waiting for one; undefined once finished. */
  async take<T>(pick: (frame: Frame) => T | undefined, signal: AbortSignal): Promise<T | undefined> {
    while (true) {
      for (const [index, frame] of this.items.entries()) {
        const picked = pick(frame)
        if (picked !== undefined) {
          if ((frame as { __drained?: boolean }).__drained !== false) this.items.splice(index, 1)
          return picked
        }
      }
      if (this.finished) return undefined
      signal.throwIfAborted()
      this.waiter = deferred<void>()
      const wait = this.waiter.promise
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { reject(signal.reason) }
        signal.addEventListener('abort', onAbort, { once: true })
        void wait.then(() => { signal.removeEventListener('abort', onAbort); resolve() })
      })
    }
  }
}

/** tool_result outcome for one id inside a sub-agent user frame. */
function resultIn(frame: Frame, toolUseId: string): ClaudeToolOutcome | undefined {
  if (frame.type !== 'user' || !Array.isArray(frame.message?.content)) return undefined
  const blocks = frame.message.content as Frame[]
  const index = blocks.findIndex(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)
  if (index < 0) return undefined
  const block = blocks[index]!
  const single = blocks.filter(entry => entry.type === 'tool_result').length === 1
  blocks.splice(index, 1)
  // Keep the frame while other results in it are still unclaimed.
  ;(frame as { __drained?: boolean }).__drained = !blocks.some(entry => entry.type === 'tool_result')
  return {
    text: toolResultText(block.content),
    isError: block.is_error === true,
    ...single && frame.tool_use_result !== undefined ? { structured: frame.tool_use_result } : {},
    blocks: Array.isArray(block.content) ? block.content as Record<string, unknown>[] : [],
  }
}

export class AgentsBridge {
  private readonly feeds = new Map<string, Feed>()

  constructor(private readonly ctx: Context, private readonly runtime: ClaudeCodeRuntime) {}

  /** dsh subagent provider whose children mirror Claude sub-agents. */
  provider() {
    return {
      name: SUBAGENT_PROVIDER,
      capabilities: { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: (request: Parameters<typeof startInProcessRun>[0]) => startInProcessRun(request, {}),
    }
  }

  private feed(root: AgentState, toolUseId: string): Feed {
    let feed = this.feeds.get(toolUseId)
    if (feed === undefined) {
      feed = new Feed(root)
      this.feeds.set(toolUseId, feed)
    }
    return feed
  }

  /** SDK sub-agent traffic for the Agent tool call `parentToolUseId`. */
  onSubagentMessage(root: AgentState, parentToolUseId: string, message: unknown): void {
    this.feed(root, parentToolUseId).push(message as Frame)
  }

  startChild(root: AgentState, parent: Agent, call: TranslatedToolCall, signal: AbortSignal): void {
    const subagents = (parent.ctx.get('subagents') ?? this.ctx.get('subagents')) as {
      start(provider: string, request: unknown): Promise<{ id: string; result: Promise<unknown>; dispose(): Promise<void> }>
    } | undefined
    if (subagents === undefined) return
    this.feed(root, call.id)
    const prompt = typeof call.input.prompt === 'string' ? call.input.prompt : ''
    const label = typeof call.input.description === 'string' ? call.input.description : 'Claude Code sub-agent'
    void subagents.start(SUBAGENT_PROVIDER, {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal,
      agentOptions: { provider: this.runtime.config.provider, model: `${SUBAGENT_MODEL_PREFIX}${call.id}` },
    }).then((run) => {
      this.runtime.state(parent.id).ownChildren.add(run.id)
      return run.result.finally(() => run.dispose())
    }).catch((error: unknown) => {
      this.runtime.warn(`could not show Claude sub-agent ${call.id} as a dsh child: ${String(error)}`)
    })
  }

  finishChild(toolUseId: string): void {
    this.feeds.get(toolUseId)?.finish()
  }

  /**
   * One step of a dsh child mirroring a Claude sub-agent: the next assistant
   * frame, then its tool calls and their results.
   */
  async mirrorStep(context: StepContext, toolUseId: string, driver: ClaudeStepDriver): Promise<StepEnd> {
    const feed = this.feeds.get(toolUseId)
    if (feed === undefined) return { kind: 'completed' }
    const frame = await feed.take(f => f.type === 'assistant' ? f : undefined, context.signal)
    if (frame === undefined) {
      this.feeds.delete(toolUseId)
      return { kind: 'completed' }
    }
    const { agent, turn, step } = context
    const translator = new MessageTranslator()
    translator.begin(String(frame.message?.id ?? ''), frame.message?.usage)
    const attempt = context.createAttempt()
    attempt.start()
    for (const chunk of translator.whole((frame.message?.content ?? []) as Frame[])) attempt.push(chunk)
    for (const chunk of translator.finish()) attempt.push(chunk)
    const content = attempt.blocks()
    if (content.length === 0) {
      attempt.settle('assistant/attempt', () => agent.session.append('assistant/attempt', { turn, step, stream: attempt.stream as never }).seq)
      return null
    }
    attempt.settle('assistant/message', () => agent.session.append('assistant/message', {
      turn,
      step,
      message: createAssistantMessage({ content, source: { provider: context.config.provider, model: context.config.model } }),
      ...translator.usage === undefined ? {} : { usage: translator.usage },
      stream: attempt.stream as never,
    }, { surfaceOp: 'append' }).seq)

    const calls = translator.toolCalls
    const seqs = calls.map((call) => {
      const seq = agent.session.append('tool/call', { turn, step, callId: call.id as never, name: call.dsh.name, arguments: call.argumentsText }).seq
      // Permission prompts for the sub-agent's tools attach to the child's card.
      feed.root.toolOwners.set(call.id, agent)
      feed.root.markAppended(call.id)
      if (call.dsh.name === 'subagent') this.startChild(feed.root, agent, call, context.signal)
      return seq
    })
    for (const [index, call] of calls.entries()) {
      const outcome = await feed.take(f => resultIn(f, call.id), context.signal)
        ?? { text: 'Claude Code ended the sub-agent before this tool reported a result.', isError: true }
      if (call.dsh.name === 'subagent') this.finishChild(call.id)
      const executed = feed.root.dshResults.get(call.id)
      if (executed !== undefined) feed.root.dshResults.delete(call.id)
      const result = executed ?? await driver.mapOutcome(agent, feed.root, call, outcome)
      driver.commitResult(context, call, result, seqs[index]!)
    }
    return null
  }
}
