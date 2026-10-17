/**
 * The `claude-code` provider as dsh's model catalog sees it, plus the
 * auxiliary model calls dsh makes outside agent steps.
 *
 * Agent steps on this route never reach `stream()`: the patched agent loop
 * hands them to the Claude step driver. `stream()` answers dsh's own
 * auxiliary requests: session titles (a small tool-less Claude Code query) and
 * compaction summaries — when Claude is idle, dsh's compaction of a Claude
 * session runs Claude Code's own `/compact` and uses Claude's summary, so both
 * histories are compacted with the same summary.
 *
 * @module dsh-claude-code-provider/adapter
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from './dsh-types.ts'
import { childEnv } from './config.ts'
import { EFFORTS, SUBAGENT_MODEL_PREFIX, type ClaudeCodeRuntime } from './runtime.ts'

/**
 * Context window of a Claude Code model. The Claude 5 family has 1M; older
 * models 200k unless Claude Code runs them with the `[1m]` variant.
 * @param model - Claude Code model value (`opus`, `sonnet[1m]`, `claude-opus-4-8`, …).
 * @param resolved - the concrete model id Claude Code resolves it to, when known.
 */
export function contextWindowFor(model: string, resolved: string | undefined): number {
  if (model.endsWith('[1m]')) return 1_000_000
  const id = resolved ?? model
  return /^claude-(?:3|(?:opus|sonnet|haiku)-4)/.test(id) ? 200_000 : 1_000_000
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export class ClaudeCodeAdapter extends LlmAdapter {
  constructor(private readonly runtime: ClaudeCodeRuntime) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.runtime.config.displayName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.runtime.models()
    return models.map(model => ({
      provider,
      id: model.value,
      name: `Claude Code - ${model.displayName}`,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: ['text', 'image'],
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model.startsWith(SUBAGENT_MODEL_PREFIX)) {
      return { provider, id: model, name: 'Claude Code - sub-agent', inputModalities: ['text', 'image'], context: { contextWindow: 1_000_000 } }
    }
    const known = (await this.runtime.models()).find(entry => entry.value === model)
    const efforts = known?.supportedEffortLevels ?? [...EFFORTS]
    return {
      provider,
      id: model,
      name: `Claude Code - ${known?.displayName ?? model}`,
      inputModalities: ['text', 'image'],
      context: { contextWindow: contextWindowFor(model, known?.resolvedModel) },
      reasoning: { efforts: efforts.map(effort => ({ id: effort as ReasoningEffortId, name: effort })) },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'compaction' && options.sessionId !== undefined) {
      const claude = this.runtime.states.get(options.sessionId)?.claude
      if (claude?.pendingCompactSummary !== undefined) {
        const summary = claude.pendingCompactSummary
        claude.pendingCompactSummary = undefined
        yield* textChunks(summary)
        return
      }
      if (claude !== undefined && !claude.isClosed && !claude.turnActive && !claude.streaming) {
        try {
          yield* textChunks(await claude.compact(options.signal))
          return
        } catch (error: unknown) {
          this.runtime.warn(`Claude Code /compact failed, summarizing separately: ${String(error)}`)
        }
      }
    }
    if (options.purpose === undefined && options.sessionId !== undefined && this.runtime.agentFor(options.sessionId) !== undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'dsh-claude-code-provider: the agent loop is not patched (run scripts/apply-patches.sh), so Claude Code cannot drive this session',
            code: 'CLAUDE_CODE_LOOP_NOT_PATCHED',
          },
        },
      }
      return
    }
    yield* this.oneShot(options)
  }

  /** A tool-less Claude Code query for an auxiliary request. */
  private async *oneShot(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = options.purpose !== undefined ? 'haiku' : options.model.startsWith(SUBAGENT_MODEL_PREFIX) ? 'default' : options.model
    const controller = new AbortController()
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
    const q = (this.runtime.queryFn ?? query)({
      prompt: renderTranscript(options),
      options: {
        abortController: controller,
        pathToClaudeCodeExecutable: this.runtime.config.claudePath,
        env: childEnv(this.runtime.config),
        tools: [],
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        systemPrompt: options.system ?? 'Answer the final request in the conversation directly and concisely.',
        ...model === 'default' ? {} : { model },
      },
    })
    let text = ''
    let error: string | undefined
    try {
      for await (const message of q) {
        if (message.type !== 'result') continue
        if (message.subtype === 'success' && !message.is_error) text = message.result
        else error = message.subtype === 'success' ? message.result : (message.errors ?? []).join('; ') || message.subtype
      }
    } catch (thrown: unknown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      q.close()
    }
    if (error !== undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `Claude Code: ${error}`, code: 'CLAUDE_CODE_ONESHOT' } } }
      return
    }
    yield* textChunks(text)
  }
}

/** Flatten a dsh request into one prompt for a tool-less query. */
function renderTranscript(options: GenerateOptions): string {
  const parts: string[] = []
  for (const message of options.messages) {
    const text = (message.content as readonly ContentBlock[])
      .map((block) => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool-call') return `[called ${block.name}(${block.arguments.slice(0, 500)})]`
        return ''
      })
      .filter(chunk => chunk.length > 0)
      .join('\n')
    if (text.length === 0) continue
    switch (message.role) {
      case 'system': break
      case 'assistant': parts.push(`Assistant: ${text}`); break
      case 'tool': parts.push(`Tool result: ${text.slice(0, 2000)}`); break
      default: parts.push(options.messages.length === 1 ? text : `User: ${text}`); break
    }
  }
  return parts.join('\n\n')
}
