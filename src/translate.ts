/**
 * Claude API message stream → dsh stream chunks for one assistant message.
 *
 * Text and thinking stream as dsh text and reasoning blocks. Tool uses become
 * dsh tool-call blocks named and shaped by {@link toDshCall}: when Claude's
 * argument JSON already has the dsh shape it streams live into the card;
 * otherwise the translated arguments arrive whole when the block completes.
 *
 * @module dsh-claude-code-provider/translate
 */

import type { ContentBlock, StreamChunk, TokenUsage, ToolCallId } from './dsh-types.ts'
import { toDshCall, type DshCall } from './toolmap.ts'

/** One completed tool use in the current message. */
export interface TranslatedToolCall {
  readonly id: string
  readonly claudeName: string
  readonly input: Record<string, unknown>
  readonly dsh: DshCall
  /** The exact argument JSON recorded on the assistant message and the tool/call event. */
  readonly argumentsText: string
}

interface OpenBlock {
  /** dsh block index; -1 while a thinking block has produced no text. */
  dsh: number
  readonly kind: 'text' | 'reasoning' | 'tool'
  text: string
  readonly id?: string
  readonly claudeName?: string
  /** Tool name streamed so far (the verbatim-name guess before the input is known). */
  readonly streamName?: string
}

export function anthropicUsage(raw: unknown, base?: TokenUsage): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return base
  const u = raw as Record<string, unknown>
  const num = (key: string): number | undefined => typeof u[key] === 'number' ? u[key] : undefined
  const input = num('input_tokens') ?? base?.inputTokens
  const output = num('output_tokens') ?? base?.outputTokens
  if (input === undefined && output === undefined) return base
  const cacheRead = num('cache_read_input_tokens') ?? base?.cacheReadTokens
  const cacheWrite = num('cache_creation_input_tokens') ?? base?.cacheWriteTokens
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
  }
}

/** Claude task-list tools, recorded as dsh `todo_write` (their arguments are decided at completion). */
export const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

/** Claude tool names whose input JSON already has the dsh argument shape. */
function streamsVerbatim(claudeName: string): boolean {
  return toDshCall(claudeName, {}).streamsVerbatim
}

export class MessageTranslator {
  private nextIndex = 0
  private readonly open = new Map<number, OpenBlock>()
  readonly toolCalls: TranslatedToolCall[] = []
  usage: TokenUsage | undefined
  messageId: string | undefined
  /** Whether any block was emitted (an empty message settles as nothing). */
  emitted = false

  /**
   * @param onToolCall - called once each tool use's input is complete.
   * @param map - Claude call → dsh call (stateful mappings such as Claude's task list).
   */
  constructor(
    private readonly onToolCall: (call: TranslatedToolCall) => void = () => {},
    private readonly map: (claudeName: string, input: Record<string, unknown>) => DshCall = toDshCall,
  ) {}

  begin(messageId: string, usage: unknown): void {
    this.messageId = messageId
    this.usage = anthropicUsage(usage)
  }

  /**
   * Translate one partial-message stream event.
   * @returns the dsh chunks it produces (possibly none).
   */
  event(event: Record<string, any>): StreamChunk[] {
    switch (event.type) {
      case 'content_block_start': return this.blockStart(event.index, event.content_block)
      case 'content_block_delta': return this.blockDelta(event.index, event.delta)
      case 'content_block_stop': return this.blockStop(event.index)
      case 'message_delta':
        this.usage = anthropicUsage(event.usage, this.usage)
        return []
      default:
        return []
    }
  }

  /** Chunks closing the message: usage, then the finish reason. */
  finish(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    if (this.usage !== undefined) chunks.push({ type: 'usage', usage: this.usage })
    chunks.push({ type: 'finish', reason: { kind: this.toolCalls.length > 0 ? 'tool-calls' : 'stop' } })
    return chunks
  }

  /** Translate a complete (non-streamed) assistant message's blocks. */
  whole(content: ReadonlyArray<Record<string, any>>): StreamChunk[] {
    const chunks: StreamChunk[] = []
    content.forEach((block, i) => {
      const index = 10_000 + i
      chunks.push(...this.blockStart(index, block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '', thinking: '' }))
      if (block.type === 'text' && typeof block.text === 'string') chunks.push(...this.blockDelta(index, { type: 'text_delta', text: block.text }))
      if (block.type === 'thinking' && typeof block.thinking === 'string') chunks.push(...this.blockDelta(index, { type: 'thinking_delta', thinking: block.thinking }))
      if (block.type === 'tool_use') chunks.push(...this.blockDelta(index, { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }))
      chunks.push(...this.blockStop(index))
    })
    return chunks
  }

  private blockStart(index: number, block: Record<string, any>): StreamChunk[] {
    switch (block.type) {
      case 'text': {
        const dsh = this.nextIndex++
        this.open.set(index, { dsh, kind: 'text', text: '' })
        this.emitted = true
        const chunks: StreamChunk[] = [{ type: 'block-start', index: dsh, blockType: 'text' }]
        if (typeof block.text === 'string' && block.text.length > 0) {
          this.open.get(index)!.text = block.text
          chunks.push({ type: 'text-delta', index: dsh, text: block.text })
        }
        return chunks
      }
      case 'thinking':
        // Started lazily: thinking that stays empty (omitted display) shows nothing.
        this.open.set(index, { dsh: -1, kind: 'reasoning', text: '' })
        return typeof block.thinking === 'string' && block.thinking.length > 0
          ? this.blockDelta(index, { type: 'thinking_delta', thinking: block.thinking })
          : []
      case 'tool_use': {
        const dsh = this.nextIndex++
        const claudeName = String(block.name)
        const verbatim = streamsVerbatim(claudeName) && !TASK_TOOLS.has(claudeName)
        const streamName = toDshCall(claudeName, {}).name
        this.open.set(index, { dsh, kind: 'tool', text: '', id: String(block.id), claudeName, ...verbatim ? { streamName } : {} })
        this.emitted = true
        return [
          { type: 'block-start', index: dsh, blockType: 'tool-call' },
          // The dsh name is fixed by the Claude name except for image reads,
          // which are only known once the input arrives; announce it then.
          ...verbatim ? [{ type: 'tool-call-delta' as const, index: dsh, id: block.id as ToolCallId, name: streamName, argumentsDelta: '' }] : [],
        ]
      }
      default:
        return []
    }
  }

  private blockDelta(index: number, delta: Record<string, any>): StreamChunk[] {
    const block = this.open.get(index)
    if (block === undefined) return []
    if (delta.type === 'text_delta' && block.kind === 'text') {
      block.text += delta.text
      return [{ type: 'text-delta', index: block.dsh, text: delta.text }]
    }
    if (delta.type === 'thinking_delta' && block.kind === 'reasoning') {
      if (typeof delta.thinking !== 'string' || delta.thinking.length === 0) return []
      const chunks: StreamChunk[] = []
      if (block.dsh === -1) {
        block.dsh = this.nextIndex++
        this.emitted = true
        chunks.push({ type: 'block-start', index: block.dsh, blockType: 'reasoning' })
      }
      block.text += delta.thinking
      chunks.push({ type: 'reasoning-delta', index: block.dsh, text: delta.thinking })
      return chunks
    }
    if (delta.type === 'input_json_delta' && block.kind === 'tool') {
      block.text += delta.partial_json
      return block.streamName === undefined
        ? []
        : [{ type: 'tool-call-delta', index: block.dsh, id: block.id as ToolCallId, argumentsDelta: delta.partial_json }]
    }
    return []
  }

  private blockStop(index: number): StreamChunk[] {
    const block = this.open.get(index)
    if (block === undefined) return []
    this.open.delete(index)
    if (block.dsh === -1) return []
    let final: ContentBlock
    const chunks: StreamChunk[] = []
    switch (block.kind) {
      case 'text':
        final = { type: 'text', text: block.text }
        break
      case 'reasoning':
        final = { type: 'reasoning', text: block.text }
        break
      case 'tool': {
        let input: Record<string, unknown> = {}
        try {
          const parsed: unknown = block.text.length > 0 ? JSON.parse(block.text) : {}
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
        } catch {
          input = {}
        }
        const dsh = this.map(block.claudeName!, input)
        const streamedWhole = block.streamName === dsh.name
        const argumentsText = streamedWhole ? (block.text.length > 0 ? block.text : '{}') : JSON.stringify(dsh.args)
        const call: TranslatedToolCall = { id: block.id!, claudeName: block.claudeName!, input, dsh, argumentsText }
        this.toolCalls.push(call)
        this.onToolCall(call)
        // Translated arguments (and a name decided by the input) arrive whole.
        if (!streamedWhole) {
          chunks.push({ type: 'tool-call-delta', index: block.dsh, id: block.id as ToolCallId, name: dsh.name, argumentsDelta: block.streamName === undefined ? argumentsText : '' })
        }
        final = { type: 'tool-call', id: block.id as ToolCallId, name: dsh.name, arguments: argumentsText }
        break
      }
    }
    chunks.push({ type: 'block-end', index: block.dsh, block: final })
    return chunks
  }
}
