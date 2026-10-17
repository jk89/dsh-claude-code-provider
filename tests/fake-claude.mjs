// Scripted stand-in for the Agent SDK's query(): emits realistic SDK message
// traffic so the whole dsh integration can be exercised without any model.
// Test helper only — never shipped (package.json "files" excludes tests/).
// Scenarios are chosen by a keyword in the user's message: "SCENARIO <name>".
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
const record = (entry) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`) }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function query({ prompt, options }) {
  return new FakeQuery(prompt, options ?? {})
}

class FakeQuery {
  constructor(prompt, options) {
    this.options = options
    this.out = []
    this.wake = undefined
    this.closed = false
    this.inbox = []
    this.inboxWake = undefined
    this.turnBusy = false
    this.interruptRequested = false
    this.folded = []
    this.permissionMode = options.permissionMode
    this.model = options.model
    this.sessionId = options.resume !== undefined && options.forkSession !== true ? options.resume : randomUUID()
    this.log = { push: record }
    this.log.push({ event: 'start', options: { resume: options.resume, forkSession: options.forkSession, resumeSessionAt: options.resumeSessionAt, permissionMode: options.permissionMode, model: options.model, disallowedTools: options.disallowedTools, append: options.systemPrompt?.append } })
    void this.consume(prompt)
    void this.loop()
  }

  // ---- Query surface ----
  async *[Symbol.asyncIterator]() {
    while (true) {
      const message = this.out.shift()
      if (message !== undefined) { yield message; continue }
      if (this.closed) return
      await new Promise(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
  async interrupt() { this.interruptRequested = true; this.log.push({ event: 'interrupt' }) }
  async setModel(model) { this.model = model; this.log.push({ event: 'setModel', model }) }
  async setPermissionMode(mode) { this.permissionMode = mode; this.log.push({ event: 'setPermissionMode', mode }) }
  async applyFlagSettings(settings) { this.log.push({ event: 'applyFlagSettings', settings }) }
  async supportedModels() { return [{ value: 'default', displayName: 'Default (fake)', description: 'fake' }, { value: 'opus', displayName: 'Opus (fake)', description: 'fake', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }, { value: 'haiku', displayName: 'Haiku (fake)', description: 'fake' }] }
  async supportedCommands() { return [{ name: 'review-pr', description: 'Review a pull request', argumentHint: '<number>' }, { name: 'compact', description: 'Compact (shadowed by dsh)', argumentHint: '' }] }
  async stopTask(taskId) { this.log.push({ event: 'stopTask', taskId }); this.stopped = taskId }
  close() { this.closed = true; this.wake?.() }

  // ---- plumbing ----
  emit(message) { this.out.push(message); this.wake?.() }
  async consume(prompt) {
    if (typeof prompt === 'string') {
      // One-shot query (titles, separate compaction summaries): one answer, then the query ends.
      this.oneShot = true
      this.inbox.push({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: prompt } })
      this.inboxWake?.()
      return
    }
    for await (const message of prompt) {
      if (this.turnBusy) { this.folded.push(message); continue }
      this.inbox.push(message)
      this.inboxWake?.()
    }
  }
  async loop() {
    this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId, model: this.model ?? 'fake', tools: ['Bash', 'Read'], cwd: this.options.cwd, apiKeySource: 'none', claude_code_version: 'fake', uuid: randomUUID() })
    while (!this.closed) {
      const message = this.inbox.shift()
      if (message === undefined) { await new Promise(resolve => { this.inboxWake = resolve }); this.inboxWake = undefined; continue }
      this.turnBusy = true
      this.interruptRequested = false
      this.turn = { uuids: [message.uuid], stamped: false }
      try {
        await this.runTurn(textOf(message.message.content))
      } catch (error) {
        this.log.push({ event: 'turn-error', error: String(error) })
      }
      this.result(this.interruptRequested ? 'error_during_execution' : 'success')
      this.turnBusy = false
      if (this.oneShot) this.close()
      if (this.folded.length > 0) { this.inbox.push(...this.folded); this.folded = [] }
    }
  }
  stamp() {
    if (this.turn.stamped) return {}
    this.turn.stamped = true
    return { user_message_uuid: this.turn.uuids.at(-1), user_message_uuids: this.turn.uuids }
  }
  result(subtype) {
    const uuids = [...this.turn.uuids, ...this.folded.map(m => m.uuid)]
    this.folded = []
    const resultText = this.resultText ?? 'done'
    this.resultText = undefined
    this.emit({ type: 'result', subtype, is_error: subtype !== 'success', result: resultText, errors: subtype === 'success' ? undefined : ['interrupted'], user_message_uuid: uuids.at(-1), user_message_uuids: uuids, session_id: this.sessionId, uuid: randomUUID(), duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} })
  }
  ev(event, parent = null) { this.emit({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: randomUUID(), session_id: this.sessionId, ...this.stamp() }) }

  /** One streamed assistant message with text and/or tool uses. Returns tool ids. */
  async message({ text, thinking, tools = [], delay = 5, cacheRead = 8000 }) {
    if (this.interruptRequested) return []
    const id = `msg_${randomUUID().slice(0, 8)}`
    this.ev({ type: 'message_start', message: { id, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: cacheRead } } })
    let index = 0
    const content = []
    if (thinking !== undefined) {
      this.ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
      this.ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })
      this.ev({ type: 'content_block_stop', index })
      content.push({ type: 'thinking', thinking })
      index++
    }
    if (text !== undefined) {
      this.ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const word of text.split(/(?<= )/)) {
        if (this.interruptRequested) return []
        this.ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } })
        await sleep(delay)
      }
      this.ev({ type: 'content_block_stop', index })
      content.push({ type: 'text', text })
      index++
    }
    const ids = []
    for (const tool of tools) {
      const toolId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
      ids.push(toolId)
      this.ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId, name: tool.name, input: {} } })
      const json = JSON.stringify(tool.input)
      for (let i = 0; i < json.length; i += 12) this.ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 12) } })
      this.ev({ type: 'content_block_stop', index })
      content.push({ type: 'tool_use', id: toolId, name: tool.name, input: tool.input })
      index++
    }
    this.emit({ type: 'assistant', message: { id, role: 'assistant', content, usage: { input_tokens: 1200, output_tokens: 40 } }, parent_tool_use_id: null, uuid: randomUUID(), session_id: this.sessionId })
    this.ev({ type: 'message_delta', delta: { stop_reason: tools.length > 0 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 40 } })
    this.ev({ type: 'message_stop' })
    return ids
  }

  toolResult(id, text, structured, isError = false, extraBlocks = []) {
    this.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: extraBlocks.length > 0 ? [{ type: 'text', text }, ...extraBlocks] : text, is_error: isError }] }, parent_tool_use_id: null, tool_use_result: structured, uuid: randomUUID(), session_id: this.sessionId })
  }

  async permission(toolName, input, toolUseID, title) {
    if (this.permissionMode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input }
    const decision = await this.options.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID, title, requestId: randomUUID() })
    this.log.push({ event: 'permission', toolName, decision })
    return decision
  }

  async mcpCall(name, args, toolUseId) {
    const server = this.options.mcpServers?.dsh?.instance?.server
    const handler = server?._requestHandlers?.get('tools/call')
    if (handler === undefined) return { content: [{ type: 'text', text: 'no dsh MCP server' }], isError: true }
    return handler({ method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } } }, { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) })
  }

  async mcpList() {
    const handler = this.options.mcpServers?.dsh?.instance?.server?._requestHandlers?.get('tools/list')
    return handler === undefined ? { tools: [] } : handler({ method: 'tools/list', params: {} }, { signal: new AbortController().signal, requestId: 2, sendNotification: async () => {}, sendRequest: async () => ({}) })
  }

  // ---- scenarios ----
  async runTurn(text) {
    const cwd = this.options.cwd ?? process.cwd()
    if (this.oneShot) {
      await this.message({ text: 'FAKE ONE-SHOT ANSWER' })
      return
    }
    if (text.trim() === '/compact') {
      // Real Claude Code: a second /compact with nothing new answers without compacting (no hook).
      if (this.justCompacted) { this.resultText = 'Not enough messages to compact.'; return }
      this.justCompacted = true
      this.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 90000 }, uuid: randomUUID(), session_id: this.sessionId })
      await this.options.hooks?.PostCompact?.[0]?.hooks?.[0]?.({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'FAKE CLAUDE COMPACT SUMMARY: user is testing dsh-claude-code-provider.' }, undefined, { signal: new AbortController().signal })
      return
    }
    this.justCompacted = false
    const name = /SCENARIO (\S+)/.exec(text)?.[1] ?? 'echo'
    switch (name) {
      case 'bash': {
        const [id] = await this.message({ thinking: 'I should run the command.', text: 'Running it.', tools: [{ name: 'Bash', input: { command: 'echo hello && false', description: 'Print hello then fail' } }] })
        const decision = await this.permission('Bash', { command: 'echo hello && false' }, id, 'Claude wants to run echo hello && false')
        if (decision.behavior === 'allow') this.toolResult(id, 'hello\nError: Exit code 1', { stdout: 'hello\n', stderr: '', interrupted: false }, true)
        else this.toolResult(id, decision.message, undefined, true)
        await this.message({ text: decision.behavior === 'allow' ? 'The command printed hello and exited 1.' : `Not allowed: ${decision.message}` })
        return
      }
      case 'files': {
        const ids = await this.message({ text: 'Reading, editing and writing.', tools: [
          { name: 'Read', input: { file_path: `${cwd}/calc.py` } },
        ] })
        this.toolResult(ids[0], '     1\tdef add(a, b):\n     2\t    return a - b\n', { type: 'text', file: { filePath: `${cwd}/calc.py`, content: 'def add(a, b):\n    return a - b\n', numLines: 2, startLine: 1, totalLines: 2 } })
        const ids2 = await this.message({ tools: [
          { name: 'Edit', input: { file_path: `${cwd}/calc.py`, old_string: 'a - b', new_string: 'a + b' } },
          { name: 'Write', input: { file_path: `${cwd}/notes.md`, content: '# Notes\n\nadd() fixed.\n' } },
        ] })
        this.toolResult(ids2[0], 'The file has been updated successfully.', { filePath: `${cwd}/calc.py`, oldString: 'a - b', newString: 'a + b', originalFile: 'def add(a, b):\n    return a - b\n', structuredPatch: [], userModified: false, replaceAll: false })
        this.toolResult(ids2[1], 'File created successfully.', { type: 'create', filePath: `${cwd}/notes.md`, content: '# Notes\n\nadd() fixed.\n', structuredPatch: [], originalFile: null })
        await this.message({ text: 'Fixed add() and wrote notes.md.' })
        return
      }
      case 'search': {
        const ids = await this.message({ text: 'Searching.', tools: [
          { name: 'Grep', input: { pattern: 'def ', path: cwd, glob: '*.py', output_mode: 'content', '-n': true } },
          { name: 'Glob', input: { pattern: '**/*.py', path: cwd } },
          { name: 'WebFetch', input: { url: 'https://example.com', prompt: 'title?' } },
          { name: 'WebSearch', input: { query: 'deepseek harness' } },
        ] })
        this.toolResult(ids[0], `${cwd}/calc.py:1:def add(a, b):`, { mode: 'content', numFiles: 1, filenames: [], content: `${cwd}/calc.py:1:def add(a, b):`, numLines: 1 })
        this.toolResult(ids[1], `${cwd}/calc.py`, { durationMs: 3, numFiles: 1, filenames: [`${cwd}/calc.py`], truncated: false })
        this.toolResult(ids[2], 'The page title is Example Domain.', { bytes: 1256, code: 200, codeText: 'OK', result: 'The page title is Example Domain.', durationMs: 120, url: 'https://example.com' })
        this.toolResult(ids[3], 'Found results.', { query: 'deepseek harness', results: [{ tool_use_id: 'srv_1', content: [{ title: 'DeepSeek Harness', url: 'https://github.com/deepseek-ai/deepseek-harness', snippet: 'Agent harness' }] }], durationSeconds: 1 })
        await this.message({ text: 'Search done.' })
        return
      }
      case 'todo': {
        const input = { todos: [{ content: 'Fix add()', status: 'completed', activeForm: 'Fixing add()' }, { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }, { content: 'Ship', status: 'pending', activeForm: 'Shipping' }] }
        const [id] = await this.message({ tools: [{ name: 'TodoWrite', input }] })
        this.toolResult(id, 'Todos have been modified successfully.', { oldTodos: [], newTodos: input.todos })
        await this.message({ text: 'Todo list updated.' })
        return
      }
      case 'dshbash': {
        const list = await this.mcpList()
        this.log.push({ event: 'mcp-tools', tools: list.tools.map(t => t.name) })
        const input = { command: 'echo sandboxed-ok', description: 'Echo through dsh bash' }
        const [id] = await this.message({ text: 'Running through dsh.', tools: [{ name: 'mcp__dsh__bash', input }] })
        const out = await this.mcpCall('bash', input, id)
        this.toolResult(id, out.content.map(c => c.text ?? '').join('\n'), undefined, out.isError === true)
        await this.message({ text: `dsh bash said: ${out.content[0]?.text?.split('\n')[0] ?? ''}` })
        return
      }
      case 'tasks': {
        const [a, b] = await this.message({ tools: [{ name: 'TaskCreate', input: { subject: 'Fix add()', description: 'd' } }, { name: 'TaskCreate', input: { subject: 'Write a test', description: 'd' } }] })
        this.toolResult(a, 'Task #1 created', { task: { id: '1', subject: 'Fix add()' } })
        this.toolResult(b, 'Task #2 created', { task: { id: '2', subject: 'Write a test' } })
        const [c] = await this.message({ tools: [{ name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] })
        this.toolResult(c, 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'] })
        await this.message({ text: 'Tasks tracked.' })
        return
      }
      case 'ask': {
        const input = { questions: [{ question: 'Which colour should the button be?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red', description: 'Loud' }] }] }
        const [id] = await this.message({ tools: [{ name: 'AskUserQuestion', input }] })
        const decision = await this.permission('AskUserQuestion', input, id)
        const answer = decision.behavior === 'allow' ? decision.updatedInput.answers?.[input.questions[0].question] : undefined
        this.toolResult(id, answer === undefined ? 'User declined' : `User answered: ${answer}`, undefined, answer === undefined)
        await this.message({ text: answer === undefined ? 'No answer.' : `You chose ${answer}.` })
        return
      }
      case 'plan': {
        const plan = '# Fix calc\n\n1. Change `a - b` to `a + b`.\n2. Add a test.'
        const [id] = await this.message({ text: 'Here is my plan.', tools: [{ name: 'ExitPlanMode', input: { plan } }] })
        const decision = await this.permission('ExitPlanMode', { plan }, id)
        if (decision.behavior === 'allow') {
          this.permissionMode = 'default'
          this.toolResult(id, 'User has approved your plan.', { plan, isAgent: false })
          await this.message({ text: 'Plan approved; implementing now.' })
        } else {
          this.toolResult(id, decision.message, undefined, true)
          await this.message({ text: 'I will revise the plan.' })
        }
        return
      }
      case 'agent': {
        const [agentId] = await this.message({ text: 'Delegating to a sub-agent.', tools: [{ name: 'Agent', input: { description: 'Inspect calc.py', prompt: 'Read calc.py and report the bug.', subagent_type: 'general-purpose' } }] })
        await sleep(50)
        const sub = (message) => this.emit({ ...message, parent_tool_use_id: agentId, uuid: randomUUID(), session_id: this.sessionId })
        sub({ type: 'assistant', message: { id: 'sub_1', role: 'assistant', content: [{ type: 'text', text: 'I will read calc.py.' }] } })
        sub({ type: 'assistant', message: { id: 'sub_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sub_read', name: 'Read', input: { file_path: `${cwd}/calc.py` } }] } })
        await sleep(50)
        sub({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_read', content: '     1\tdef add(a, b):\n     2\t    return a - b\n' }] }, tool_use_result: { type: 'text', file: { filePath: `${cwd}/calc.py`, content: 'def add(a, b):\n    return a - b\n', numLines: 2, startLine: 1, totalLines: 2 } } })
        sub({ type: 'assistant', message: { id: 'sub_2', role: 'assistant', content: [{ type: 'text', text: 'Bug: add() subtracts.' }] } })
        await sleep(50)
        this.toolResult(agentId, 'Bug: add() subtracts.', { status: 'completed', content: [{ type: 'text', text: 'Bug: add() subtracts.' }] })
        await this.message({ text: 'The sub-agent found that add() subtracts.' })
        return
      }
      case 'background': {
        const [id] = await this.message({ tools: [{ name: 'Bash', input: { command: 'sleep 1 && echo built', description: 'Build in background', run_in_background: true } }] })
        this.emit({ type: 'system', subtype: 'task_started', task_id: 'bgtask1', tool_use_id: id, description: 'Build in background', task_type: 'local_bash', is_backgrounded: true, uuid: randomUUID(), session_id: this.sessionId })
        this.toolResult(id, 'Command running in background with ID: bgtask1', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bgtask1' })
        await this.message({ text: 'Started the build in the background.' })
        setTimeout(() => {
          this.emit({ type: 'system', subtype: 'task_progress', task_id: 'bgtask1', description: 'Build in background', summary: 'compiling…', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 10 }, uuid: randomUUID(), session_id: this.sessionId })
          this.emit({ type: 'system', subtype: 'task_notification', task_id: 'bgtask1', status: 'completed', output_file: '/dev/null', summary: 'Background build finished', uuid: randomUUID(), session_id: this.sessionId })
        }, 1500)
        return
      }
      case 'present': {
        const list = await this.mcpList()
        this.log.push({ event: 'mcp-tools', tools: list.tools.map(t => t.name) })
        const [goalId, presentId] = await this.message({ text: 'Setting a goal and presenting the notes.', tools: [
          { name: 'mcp__dsh__create_goal', input: { objective: 'Fix calc.py and document it' } },
          { name: 'mcp__dsh__present', input: { files: [{ path: '/tmp/cc-work2/notes.md', description: 'Notes' }] } },
        ] })
        const goal = await this.mcpCall('create_goal', { objective: 'Fix calc.py and document it' }, goalId)
        this.toolResult(goalId, goal.content.map(c => c.text ?? '').join('\n'), undefined, goal.isError === true)
        const present = await this.mcpCall('present', { files: [{ path: '/tmp/cc-work2/notes.md', description: 'Notes' }] }, presentId)
        this.toolResult(presentId, present.content.map(c => c.text ?? '').join('\n'), undefined, present.isError === true)
        await this.message({ text: 'Presented notes.md.' })
        return
      }
      case 'local': {
        const [id] = await this.message({ text: 'Handing this to the local model.', tools: [{ name: 'mcp__dsh__delegate_local', input: { task: 'SCENARIO-LOCAL create hello.txt' } }] })
        const out = await this.mcpCall('delegate_local', { task: 'SCENARIO-LOCAL create hello.txt' }, id)
        this.toolResult(id, out.content.map(c => c.text ?? '').join('\n'), undefined, out.isError === true)
        await this.message({ text: `Local model said: ${out.content[0]?.text?.split('\n')[0] ?? ''}` })
        return
      }
      case 'image': {
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        const [id] = await this.message({ tools: [{ name: 'Read', input: { file_path: `${cwd}/pixel.png` } }] })
        this.toolResult(id, '[image]', { type: 'image', file: { base64: png, type: 'image/png', originalSize: 68 } }, false, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }])
        await this.message({ text: 'That is a 1x1 pixel.' })
        return
      }
      case 'pressure': {
        // Claude's context near full (950k of 1M) across several steps, without Claude compacting.
        for (let i = 0; i < 3; i++) {
          const bulk = Array.from({ length: 10_000 }, (_, w) => `w${i}x${w}`).join(' ')
          const ids = await this.message({ text: `Step ${i}. ${bulk}`, delay: 0, cacheRead: 950_000, tools: [{ name: 'Read', input: { file_path: `${cwd}/calc.py` } }] })
          this.toolResult(ids[0], '     1\tdef add(a, b):\n', { type: 'text', file: { filePath: `${cwd}/calc.py`, content: 'def add(a, b):\n', numLines: 1, startLine: 1, totalLines: 1 } })
        }
        await this.message({ text: 'Done under pressure.', cacheRead: 950_000 })
        return
      }
      case 'long': {
        await this.message({ text: Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '), delay: 25 })
        return
      }
      case 'autocompact': {
        await this.message({ text: 'Working a lot.' })
        this.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000 }, uuid: randomUUID(), session_id: this.sessionId })
        await this.options.hooks?.PostCompact?.[0]?.hooks?.[0]?.({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'FAKE AUTO SUMMARY' }, undefined, { signal: new AbortController().signal })
        await this.message({ text: 'Continuing after compaction.' })
        return
      }
      case 'error': {
        await this.message({ text: 'About to fail.' })
        this.interruptRequested = true
        return
      }
      default:
        await this.message({ text: `OK: ${text.slice(0, 200)}` })
    }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
