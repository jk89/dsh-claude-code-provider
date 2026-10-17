/**
 * Type-only re-exports from the dsh packages this plugin programs against.
 * Every import is type-only so the plugin's runtime surface on dsh stays
 * the injected services plus the `LlmAdapter` base class.
 * @module dsh-claude-code-provider/dsh-types
 */

import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

export type { Context } from '@deepseek-ai/cordis'
export type { Agent } from '@deepseek-ai/dsh-agent'
export type {
  ContentBlock,
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  MessageId,
  ReasoningEffortId,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolCallId,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
export type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
export type { JsonValue } from '@deepseek-ai/dsh-util-values'
