/**
 * Claude Code tool calls ↔ dsh tool calls.
 *
 * Every Claude Code tool_use is recorded in the dsh session as the matching
 * dsh tool (Bash → `bash`, Read → `read`, Edit → `edit`, …) with dsh-shaped
 * arguments, and its result is recorded the way that dsh tool would record
 * it: Claude's structured `tool_use_result` is converted into the dsh tool's
 * canonical value, and the dsh tool's own `output.render()` and
 * `output.presentationMeta()` produce the model-facing text and the card
 * metadata. The web client therefore renders Claude's work with dsh's own
 * cards (terminal, read, diff, search, web, todo, question, plan review,
 * subagent, image), and a later switch to a dsh model sees ordinary dsh
 * history.
 *
 * @module dsh-claude-code-provider/toolmap
 */

import type { ContentBlock, JsonValue, ToolDefinition } from './dsh-types.ts'

/** A Claude tool call expressed as a dsh tool call. */
export interface DshCall {
  /** dsh tool name. */
  readonly name: string
  /** dsh-shaped arguments. */
  readonly args: Record<string, unknown>
  /**
   * Whether Claude's streamed argument JSON already has the dsh shape, so it
   * can stream into the card while Claude writes it.
   */
  readonly streamsVerbatim: boolean
}

/** Claude's own outcome for one tool call. */
export interface ClaudeToolOutcome {
  /** tool_result content flattened to text. */
  readonly text: string
  readonly isError: boolean
  /** Structured `tool_use_result` (per-tool Output object), when the SDK supplied one. */
  readonly structured?: unknown
  /** Raw tool_result content blocks (images included). */
  readonly blocks?: readonly Record<string, unknown>[]
}

/** The dsh tool result to record. */
export interface DshResult {
  readonly content: ContentBlock[]
  readonly isError: boolean
  readonly meta?: JsonValue
  readonly error?: { name: string; code: string; reason?: string }
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i
/** Prefix of tools served by this plugin's in-process MCP server. */
export const DSH_MCP_PREFIX = 'mcp__dsh__'

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0] ?? ''
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** dsh tool names are identifiers. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Express one Claude tool call as a dsh tool call.
 * @param claudeName - Claude Code tool name.
 * @param input - Claude's tool input.
 */
export function toDshCall(claudeName: string, input: Record<string, unknown>): DshCall {
  switch (claudeName) {
    case 'Bash': {
      const command = str(input.command) ?? ''
      const timeout = num(input.timeout)
      return {
        name: 'bash',
        args: {
          command,
          description: str(input.description) ?? firstLine(command),
          ...timeout === undefined ? {} : { timeoutMs: timeout },
          ...input.run_in_background === true ? { run_in_background: true } : {},
        },
        streamsVerbatim: false,
      }
    }
    case 'Read': {
      const filePath = str(input.file_path) ?? ''
      if (IMAGE_FILE.test(filePath)) return { name: 'read_image', args: { file_path: filePath }, streamsVerbatim: false }
      return {
        name: 'read',
        args: {
          file_path: filePath,
          ...num(input.offset) === undefined ? {} : { offset: input.offset },
          ...num(input.limit) === undefined ? {} : { limit: input.limit },
        },
        streamsVerbatim: true,
      }
    }
    case 'Write':
      return { name: 'write', args: { file_path: str(input.file_path) ?? '', content: str(input.content) ?? '' }, streamsVerbatim: true }
    case 'Edit':
      return {
        name: 'edit',
        args: {
          file_path: str(input.file_path) ?? '',
          old_string: str(input.old_string) ?? '',
          new_string: str(input.new_string) ?? '',
          ...input.replace_all === true ? { replace_all: true } : {},
        },
        streamsVerbatim: true,
      }
    case 'Glob':
      return {
        name: 'glob',
        args: { pattern: str(input.pattern) ?? '', ...str(input.path) === undefined ? {} : { path: input.path } },
        streamsVerbatim: true,
      }
    case 'Grep':
      return {
        name: 'grep',
        args: {
          pattern: str(input.pattern) ?? '',
          ...str(input.path) === undefined ? {} : { path: input.path },
          ...str(input.glob) === undefined ? {} : { include: input.glob },
        },
        streamsVerbatim: false,
      }
    case 'WebFetch':
      return { name: 'web_fetch', args: { url: str(input.url) ?? '' }, streamsVerbatim: false }
    case 'WebSearch':
      return { name: 'web_search', args: { queries: [str(input.query) ?? ''] }, streamsVerbatim: false }
    case 'TodoWrite':
      return { name: 'todo_write', args: { todos: dshTodos(input) }, streamsVerbatim: false }
    case 'AskUserQuestion':
      return { name: 'ask_user_question', args: { questions: dshQuestions(input) }, streamsVerbatim: false }
    case 'ExitPlanMode':
      return { name: 'exit_plan_mode', args: { plan: str(input.plan) ?? '' }, streamsVerbatim: false }
    case 'Agent':
    case 'Task':
      return {
        name: 'subagent',
        args: {
          description: str(input.description) ?? 'Claude Code sub-agent',
          prompt: str(input.prompt) ?? '',
          ...str(input.subagent_type) === undefined ? {} : { subagent_type: input.subagent_type },
          ...input.run_in_background === true ? { run_in_background: true } : {},
        },
        streamsVerbatim: false,
      }
    default:
      if (claudeName.startsWith(DSH_MCP_PREFIX)) {
        return { name: claudeName.slice(DSH_MCP_PREFIX.length), args: input, streamsVerbatim: true }
      }
      return { name: sanitizeToolName(claudeName), args: input, streamsVerbatim: true }
  }
}

/** Claude TodoWrite items in dsh `todo_write` shape. */
export function dshTodos(input: unknown): Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> {
  const todos = rec(input).todos
  if (!Array.isArray(todos)) return []
  const out: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> = []
  for (const item of todos) {
    const entry = rec(item)
    const status = entry.status
    if (typeof entry.content !== 'string') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    out.push({ content: entry.content, status })
  }
  return out
}

/** Claude AskUserQuestion questions in dsh `ask_user_question` shape (ids q1, q2, …). */
export function dshQuestions(input: unknown): Array<Record<string, unknown>> {
  const questions = rec(input).questions
  if (!Array.isArray(questions)) return []
  return questions.map((raw, index) => {
    const question = rec(raw)
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
        const o = rec(option)
        return { label: str(o.label) ?? '', ...str(o.description) === undefined ? {} : { description: o.description } }
      })
      : undefined
    return {
      id: `q${index + 1}`,
      question: str(question.question) ?? '',
      ...str(question.header) === undefined ? {} : { header: question.header },
      ...options === undefined ? {} : { options },
      ...question.multiSelect === true ? { multi_select: true } : {},
    }
  })
}

/**
 * Claude AskUserQuestion answers from dsh `ask_user_question` answers.
 * @param input - Claude's AskUserQuestion input.
 * @param answers - dsh answers (`{ id, selected, custom? }`).
 * @returns question text → answer string, multi-select joined with ", ".
 */
export function claudeAnswers(input: unknown, answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }>): Record<string, string> {
  const questions = rec(input).questions
  const out: Record<string, string> = {}
  if (!Array.isArray(questions)) return out
  questions.forEach((raw, index) => {
    const text = str(rec(raw).question)
    if (text === undefined) return
    const answer = answers.find(entry => entry.id === `q${index + 1}`)
    if (answer === undefined) return
    const parts = [...answer.selected, ...answer.custom === undefined || answer.custom === '' ? [] : [answer.custom]]
    out[text] = parts.join(', ')
  })
  return out
}

/** Apply one Edit to the original text, the way Claude's Edit tool does. */
function applyEdit(original: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString === '') return newString
  return replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, () => newString)
}

const EXIT_CODE = /exit code[:\s]+(-?\d+)/i

/**
 * The dsh canonical value for one dsh tool, built from Claude's structured result.
 * @returns the value, or undefined when Claude's result does not carry what the dsh tool needs.
 */
export function dshValue(call: DshCall, claudeInput: Record<string, unknown>, outcome: ClaudeToolOutcome, cwd?: string): JsonValue | undefined {
  const s = rec(outcome.structured)
  const rel = (path: string): string => cwd !== undefined && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  switch (call.name) {
    case 'bash': {
      if (typeof s.backgroundTaskId === 'string') return { kind: 'background', jobId: s.backgroundTaskId }
      if (typeof s.stdout !== 'string' && typeof s.stderr !== 'string') return undefined
      const code = EXIT_CODE.exec(outcome.text)
      const exitCode = code === null ? (outcome.isError ? 1 : 0) : Number(code[1])
      return {
        kind: 'foreground',
        exitCode,
        signal: null,
        timedOut: num(s.timedOutAfterMs) !== undefined,
        aborted: s.interrupted === true,
        timeoutMs: num(claudeInput.timeout) ?? num(s.timedOutAfterMs) ?? 120_000,
        stdout: { text: str(s.stdout) ?? '', truncated: false },
        stderr: { text: str(s.stderr) ?? '', truncated: false },
      }
    }
    case 'read': {
      const file = rec(s.file)
      const content = str(file.content)
      if (s.type !== 'text' || content === undefined) return undefined
      const start = num(file.startLine) ?? 1
      const rows = content.length === 0 ? [] : content.replace(/\n$/, '').split('\n')
      return {
        path: str(file.filePath) ?? str(claudeInput.file_path) ?? '',
        offset: start,
        lines: rows.map((text, i) => ({ number: start + i, text })),
        totalLines: num(file.totalLines) ?? start + rows.length - 1,
      }
    }
    case 'edit': {
      const original = str(s.originalFile)
      if (original === undefined || str(s.filePath) === undefined) return undefined
      return {
        path: str(s.filePath)!,
        before: original,
        after: applyEdit(original, str(s.oldString) ?? '', str(s.newString) ?? '', s.replaceAll === true),
      }
    }
    case 'write': {
      if (str(s.filePath) === undefined || str(s.content) === undefined) return undefined
      return {
        path: str(s.filePath)!,
        operation: s.type === 'create' ? 'create' : 'update',
        before: str(s.originalFile) ?? null,
        after: str(s.content)!,
      }
    }
    case 'glob': {
      if (!Array.isArray(s.filenames)) return undefined
      const root = str(claudeInput.path)
      return { root: root === undefined || root === cwd ? '.' : rel(root), paths: s.filenames.filter((f): f is string => typeof f === 'string').map(rel) }
    }
    case 'grep': {
      if (s.mode !== undefined && s.mode !== 'content') return undefined
      const content = str(s.content)
      if (content === undefined) return undefined
      const matches: Array<{ path: string; lineNumber: number; line: string }> = []
      for (const raw of content.split('\n')) {
        const match = /^(.+?):(\d+):(.*)$/.exec(raw)
        if (match !== null) matches.push({ path: rel(match[1]!), lineNumber: Number(match[2]), line: match[3]! })
      }
      return matches.length === 0 && content.trim().length > 0 ? undefined : { matches }
    }
    case 'web_fetch': {
      if (typeof s.result !== 'string') return undefined
      return {
        url: str(s.url) ?? str(claudeInput.url) ?? '',
        statusCode: num(s.code) ?? 200,
        body: { kind: 'text', content: s.result },
        truncated: false,
      }
    }
    case 'web_search': {
      if (!Array.isArray(s.results)) return undefined
      const sources: Array<{ url: string; title?: string; snippet?: string }> = []
      const notes: string[] = []
      for (const entry of s.results) {
        if (typeof entry === 'string') {
          notes.push(entry)
          continue
        }
        for (const hit of Array.isArray(rec(entry).content) ? rec(entry).content as unknown[] : []) {
          const h = rec(hit)
          if (typeof h.url !== 'string') continue
          sources.push({ url: h.url, ...str(h.title) === undefined ? {} : { title: h.title as string }, ...str(h.snippet) === undefined ? {} : { snippet: h.snippet as string } })
        }
      }
      return { ...notes.length > 0 ? { content: notes.join('\n\n') } : {}, sources, truncated: false }
    }
    case 'todo_write': {
      const todos = dshTodos(call.args)
      return {
        todos,
        counts: {
          pending: todos.filter(t => t.status === 'pending').length,
          inProgress: todos.filter(t => t.status === 'in_progress').length,
          completed: todos.filter(t => t.status === 'completed').length,
        },
      }
    }
    default:
      return undefined
  }
}

/**
 * Build the dsh tool result for Claude's outcome.
 * @param call - the dsh call recorded for this tool use.
 * @param claudeInput - Claude's tool input.
 * @param outcome - Claude's tool_result.
 * @param definition - the dsh tool definition visible to the agent, if any.
 * @param image - a durable image block for image reads, when one was stored.
 */
export function toDshResult(
  call: DshCall,
  claudeInput: Record<string, unknown>,
  outcome: ClaudeToolOutcome,
  definition: ToolDefinition | undefined,
  image?: ContentBlock,
  cwd?: string,
): DshResult {
  if (call.name === 'read_image' && image !== undefined && !outcome.isError) {
    const path = str(claudeInput.file_path) ?? ''
    const value = { path, image: (image as unknown as { attachment: JsonValue }).attachment }
    const rendered = tryRender(definition, call.args, value)
    return {
      content: rendered?.content ?? [{ type: 'text', text: `Image file: ${path}` }, image],
      isError: false,
      meta: rendered?.meta ?? { path },
    }
  }
  if (!outcome.isError) {
    const value = dshValue(call, claudeInput, outcome, cwd)
    if (value !== undefined) {
      const rendered = tryRender(definition, call.args, value)
      if (rendered !== undefined) {
        return { content: rendered.content, isError: false, ...rendered.meta === undefined ? {} : { meta: rendered.meta } }
      }
    }
  } else if (call.name === 'bash') {
    // A failing command is a completed call in dsh; its exit code is result data.
    const value = dshValue(call, claudeInput, outcome, cwd)
    const rendered = value === undefined ? undefined : tryRender(definition, call.args, value)
    if (rendered !== undefined) return { content: rendered.content, isError: false, ...rendered.meta === undefined ? {} : { meta: rendered.meta } }
  }
  const text = outcome.text.length > 0 ? outcome.text : outcome.isError ? 'Error' : '(no output)'
  return {
    content: [{ type: 'text', text }],
    isError: outcome.isError,
    ...outcome.isError ? { error: { name: 'ClaudeCodeToolError', code: 'TOOL_ERROR', reason: firstLine(text, 200) } } : {},
  }
}

function tryRender(
  definition: ToolDefinition | undefined,
  args: Record<string, unknown>,
  value: JsonValue,
): { content: ContentBlock[]; meta?: JsonValue } | undefined {
  if (definition === undefined) return undefined
  try {
    const content = definition.output.render(args, value)
    const meta = definition.output.presentationMeta?.(args, value)
    return { content, ...meta === undefined ? {} : { meta } }
  } catch {
    return undefined
  }
}
