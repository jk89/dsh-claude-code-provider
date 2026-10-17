// Scratch unit tests: scripted fakes only — no binary, no model, no dsh process.
// Run: npm run build && npm test
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveConfig, childEnv } from '../lib/config.js'
import { handoffTranscript, toClaudeContent } from '../lib/content.js'
import { contextWindowFor } from '../lib/adapter.js'
import { ClaudeStepDriver, renderPersona, taskAwareCall } from '../lib/driver.js'
import { AgentState, ClaudeCodeRuntime, latestReplay } from '../lib/runtime.js'
import { ClaudeSession } from '../lib/session.js'
import { claudeAnswers, dshQuestions, dshValue, toDshCall, toDshResult } from '../lib/toolmap.js'
import { MessageTranslator } from '../lib/translate.js'

const tick = () => new Promise(r => setTimeout(r, 5))

// ---- tool mapping ------------------------------------------------------------

test('Claude tools map onto dsh tool names and argument shapes', () => {
  assert.deepEqual(toDshCall('Bash', { command: 'ls -la', timeout: 5000 }), { name: 'bash', args: { command: 'ls -la', description: 'ls -la', timeoutMs: 5000 }, streamsVerbatim: false })
  assert.equal(toDshCall('Read', { file_path: '/a.ts' }).name, 'read')
  assert.equal(toDshCall('Read', { file_path: '/a.PNG' }).name, 'read_image')
  assert.deepEqual(toDshCall('Grep', { pattern: 'x', glob: '*.ts' }).args, { pattern: 'x', include: '*.ts' })
  assert.deepEqual(toDshCall('WebSearch', { query: 'q' }).args, { queries: ['q'] })
  assert.equal(toDshCall('Agent', { prompt: 'p' }).name, 'subagent')
  assert.equal(toDshCall('ExitPlanMode', { plan: '# P' }).name, 'exit_plan_mode')
  assert.equal(toDshCall('mcp__dsh__present', { files: [] }).name, 'present')
  assert.equal(toDshCall('mcp__other__do.it', {}).name, 'mcp__other__do_it')
})

test('questions and answers round-trip between Claude and dsh shapes', () => {
  const input = { questions: [{ question: 'Colour?', header: 'C', multiSelect: true, options: [{ label: 'Blue', description: 'b' }, { label: 'Red', description: 'r' }] }] }
  assert.deepEqual(dshQuestions(input), [{ id: 'q1', question: 'Colour?', header: 'C', options: [{ label: 'Blue', description: 'b' }, { label: 'Red', description: 'r' }], multi_select: true }])
  assert.deepEqual(claudeAnswers(input, [{ id: 'q1', selected: ['Blue', 'Red'], custom: 'green too' }]), { 'Colour?': 'Blue, Red, green too' })
})

test('structured Claude results become dsh canonical values', () => {
  const read = dshValue(toDshCall('Read', { file_path: '/w/a.py' }), { file_path: '/w/a.py' }, { text: '', isError: false, structured: { type: 'text', file: { filePath: '/w/a.py', content: 'x\ny\n', startLine: 5, totalLines: 9 } } })
  assert.deepEqual(read, { path: '/w/a.py', offset: 5, lines: [{ number: 5, text: 'x' }, { number: 6, text: 'y' }], totalLines: 9 })
  const edit = dshValue(toDshCall('Edit', {}), {}, { text: '', isError: false, structured: { filePath: '/w/a.py', oldString: 'a', newString: 'b', originalFile: 'a a', replaceAll: true } })
  assert.deepEqual(edit, { path: '/w/a.py', before: 'a a', after: 'b b' })
  const bash = dshValue(toDshCall('Bash', { command: 'false' }), { command: 'false' }, { text: 'Error: Exit code 2', isError: true, structured: { stdout: 'o', stderr: 'e', interrupted: false } })
  assert.equal(bash.exitCode, 2)
  assert.deepEqual(dshValue(toDshCall('Bash', {}), {}, { text: '', isError: false, structured: { stdout: '', stderr: '', backgroundTaskId: 'claude-1' } }), { kind: 'background', jobId: 'claude-1' })
  const grep = dshValue(toDshCall('Grep', {}), {}, { text: '', isError: false, structured: { mode: 'content', content: '/w/a.py:3:def f():' } }, '/w')
  assert.deepEqual(grep, { matches: [{ path: 'a.py', lineNumber: 3, line: 'def f():' }] })
})

test('results render through the dsh tool definition, with a plain fallback', () => {
  const definition = { output: { render: (_args, value) => [{ type: 'text', text: `R:${value.path}` }], presentationMeta: (_args, value) => ({ p: value.path }) } }
  const call = toDshCall('Write', { file_path: '/w/n.md', content: 'x' })
  const ok = toDshResult(call, {}, { text: 'done', isError: false, structured: { type: 'create', filePath: '/w/n.md', content: 'x', originalFile: null } }, definition)
  assert.deepEqual(ok, { content: [{ type: 'text', text: 'R:/w/n.md' }], isError: false, meta: { p: '/w/n.md' } })
  const failed = toDshResult(call, {}, { text: 'denied', isError: true }, definition)
  assert.equal(failed.isError, true)
  assert.equal(failed.content[0].text, 'denied')
  const plain = toDshResult(toDshCall('NotebookEdit', {}), {}, { text: 'ok', isError: false }, undefined)
  assert.deepEqual(plain, { content: [{ type: 'text', text: 'ok' }], isError: false })
})

// ---- stream translation ------------------------------------------------------

test('a streamed message becomes dsh chunks with translated tool calls', () => {
  const seen = []
  const t = new MessageTranslator(call => seen.push(call.dsh.name))
  t.begin('m1', { input_tokens: 10 })
  const chunks = [
    ...t.event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ...t.event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }),
    ...t.event({ type: 'content_block_stop', index: 0 }),
    ...t.event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ...t.event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }),
    ...t.event({ type: 'content_block_stop', index: 1 }),
    ...t.event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }),
    ...t.event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"' } }),
    ...t.event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '}' } }),
    ...t.event({ type: 'content_block_stop', index: 2 }),
    ...t.event({ type: 'message_delta', usage: { output_tokens: 7 } }),
    ...t.finish(),
  ]
  assert.deepEqual(seen, ['bash'])
  assert.equal(chunks.filter(c => c.blockType === 'reasoning').length, 0, 'empty thinking stays hidden')
  const ends = chunks.filter(c => c.type === 'block-end').map(c => c.block)
  assert.deepEqual(ends, [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 't1', name: 'bash', arguments: '{"command":"ls","description":"ls"}' }])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.equal(chunks.at(-2).usage.outputTokens, 7)
  assert.equal(t.toolCalls[0].argumentsText, '{"command":"ls","description":"ls"}')
})

test('verbatim-shaped tool input streams live; image reads switch name at the end', () => {
  const t = new MessageTranslator()
  t.begin('m', undefined)
  const live = [
    ...t.event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'r', name: 'Read', input: {} } }),
    ...t.event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x.png"}' } }),
    ...t.event({ type: 'content_block_stop', index: 0 }),
  ]
  assert.equal(live.filter(c => c.type === 'tool-call-delta' && c.argumentsDelta.length > 0).length, 1)
  assert.equal(live.at(-1).block.name, 'read_image')
})

// ---- Claude session routing (fake query) ---------------------------------------

function fakeQuery() {
  const out = []
  let wake
  const calls = { interrupt: 0, setModel: [], flags: [], modes: [] }
  return {
    calls,
    emit(message) { out.push(message); wake?.() },
    async interrupt() { calls.interrupt += 1 },
    async setModel(m) { calls.setModel.push(m) },
    async applyFlagSettings(s) { calls.flags.push(s) },
    async setPermissionMode(m) { calls.modes.push(m) },
    async supportedCommands() { return [] },
    close() {},
    async *[Symbol.asyncIterator]() {
      while (true) {
        const m = out.shift()
        if (m) { yield m; continue }
        await new Promise(r => { wake = r })
      }
    },
  }
}

function makeSession(extra = {}) {
  const q = fakeQuery()
  const seen = { ids: [], sub: [], tasks: [], unsolicited: 0 }
  const session = new ClaudeSession({
    dshSessionId: 's1', cwd: '/tmp', executable: '/bin/false', permissionMode: 'default', allowBypass: false,
    disallowedTools: [], mcpServers: {}, env: {}, canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
    onClaudeSessionId: id => seen.ids.push(id), onSubagentMessage: (p, m) => seen.sub.push([p, m.type]),
    onTask: m => seen.tasks.push(m.subtype), onUnsolicited: () => { seen.unsolicited += 1 },
    log: () => {}, queryFn: () => q, ...extra,
  }, 'k')
  return { session, q, seen }
}

test('session routes init, tool results, sub-agent traffic and tasks', async () => {
  const { session, q, seen } = makeSession()
  session.send([{ type: 'text', text: 'go' }])
  q.emit({ type: 'system', subtype: 'init', session_id: 'c1' })
  q.emit({ type: 'user', parent_tool_use_id: null, tool_use_result: { stdout: 'x' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } })
  q.emit({ type: 'assistant', parent_tool_use_id: 'agent1', message: { id: 's', content: [] } })
  q.emit({ type: 'stream_event', parent_tool_use_id: 'agent1', event: { type: 'message_start' } })
  q.emit({ type: 'system', subtype: 'task_started', task_id: 'b1' })
  q.emit({ type: 'assistant', parent_tool_use_id: null, uuid: 'u-1', message: { id: 'msg1', content: [] } })
  await tick()
  assert.deepEqual(seen.ids, ['c1'])
  assert.deepEqual(await session.waitToolResult('t1'), { text: 'x', isError: false, structured: { stdout: 'x' }, blocks: [] })
  assert.deepEqual(seen.sub, [['agent1', 'assistant']])
  assert.deepEqual(seen.tasks, ['task_started'])
  assert.equal(session.uuidFor('msg1'), 'u-1')
  assert.equal((await session.next()).type, 'assistant')
})

test('interrupt drops the abandoned turn; a new send resumes the stream', async () => {
  const { session, q } = makeSession()
  session.send([{ type: 'text', text: 'long' }])
  const first = [...session['unconsumed']][0]
  q.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuids: [first], event: { type: 'message_start', message: { id: 'a' } } })
  await tick()
  session.interrupt()
  session.interrupt()
  assert.equal(q.calls.interrupt, 1)
  q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta' } })
  q.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [first] })
  await tick()
  assert.equal(session.hasQueued, false)
  assert.equal(session.turnActive, false)
  session.send([{ type: 'text', text: 'next' }])
  const second = [...session['unconsumed']][0]
  q.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuids: [second], event: { type: 'message_start', message: { id: 'b' } } })
  await tick()
  assert.equal((await session.next()).event.message.id, 'b')
})

test('compact() runs Claude Code /compact and resolves with its summary, invisibly', async () => {
  let options
  const q = fakeQuery()
  const session = new ClaudeSession({
    dshSessionId: 's1', cwd: '/tmp', executable: '/bin/false', permissionMode: 'default', allowBypass: false,
    disallowedTools: [], mcpServers: {}, env: {}, canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
    onClaudeSessionId: () => {}, onSubagentMessage: () => {}, onTask: () => {}, onUnsolicited: () => {}, log: () => {},
    queryFn: (params) => { options = params.options; return q },
  }, 'k')
  const summary = session.compact(undefined)
  const uuid = [...session['unconsumed']][0]
  q.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1 } })
  await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'S' }, undefined, { signal: new AbortController().signal })
  q.emit({ type: 'result', subtype: 'success', is_error: false, result: '', user_message_uuids: [uuid] })
  await tick()
  assert.equal(await summary, 'S')
  assert.equal(session.hasQueued, false, 'the internal turn never reaches the step stream')
  assert.equal(session.turnActive, false)
  assert.equal(session.pendingCompactSummary, undefined)
  // Claude's own auto-compaction (no waiter) is kept for dsh to mirror.
  await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'AUTO' }, undefined, { signal: new AbortController().signal })
  assert.equal(session.pendingCompactSummary, 'AUTO')
})

function compactSession() {
  let options
  const q = fakeQuery()
  const session = new ClaudeSession({
    dshSessionId: 's1', cwd: '/tmp', executable: '/bin/false', permissionMode: 'default', allowBypass: false,
    disallowedTools: [], mcpServers: {}, env: {}, canUseTool: async () => ({ behavior: 'deny', message: 'x' }),
    onClaudeSessionId: () => {}, onSubagentMessage: () => {}, onTask: () => {}, onUnsolicited: () => {}, log: () => {},
    queryFn: (params) => { options = params.options; return q },
  }, 'k')
  return { session, q, hook: (input) => options.hooks.PostCompact[0].hooks[0](input, undefined, { signal: new AbortController().signal }) }
}

test('compact() fails, rather than hanging, when Claude answers /compact without compacting', async () => {
  const { session, q, hook } = compactSession()
  const summary = session.compact(undefined)
  const uuid = [...session['unconsumed']][0]
  q.emit({ type: 'result', subtype: 'success', is_error: false, result: 'Not enough messages to compact.', user_message_uuids: [uuid] })
  await assert.rejects(summary, /did not compact: Not enough messages to compact/)
  assert.equal(session.turnActive, false)
  assert.equal(session.hasQueued, false)
  // A later auto-compaction is kept for dsh to mirror, not swallowed by the dead waiter.
  await hook({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'AUTO' })
  assert.equal(session.pendingCompactSummary, 'AUTO')
})

test('a cancelled compact() releases its waiter', async () => {
  const { session, hook } = compactSession()
  const controller = new AbortController()
  const summary = session.compact(controller.signal)
  controller.abort(new Error('stop'))
  await assert.rejects(summary, /stop/)
  await hook({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'LATER' })
  assert.equal(session.pendingCompactSummary, 'LATER')
})

test('Claude 5 models get a 1M window; older 4.x and 3.x models 200k unless [1m]', () => {
  assert.equal(contextWindowFor('opus', 'claude-opus-5-5'), 1_000_000)
  assert.equal(contextWindowFor('haiku', 'claude-haiku-5-5'), 1_000_000)
  assert.equal(contextWindowFor('fable', undefined), 1_000_000)
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'), 200_000)
  assert.equal(contextWindowFor('claude-opus-4-8', undefined), 200_000)
  assert.equal(contextWindowFor('claude-opus-4-8[1m]', undefined), 1_000_000)
})

test('the Claude step driver tells dsh compaction it owns its context', () => {
  assert.equal(new ClaudeStepDriver({}, {}).ownsContext, true)
})

test('frames while dsh is idle and no send is pending are announced once', async () => {
  const { session, q, seen } = makeSession()
  q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'x' } } })
  q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
  await tick()
  assert.equal(seen.unsolicited, 1)
  q.emit({ type: 'result', subtype: 'success', is_error: false, result: '' })
  await tick()
  session.streaming = true
  q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'y' } } })
  await tick()
  assert.equal(seen.unsolicited, 1)
})

test('apply() changes model, effort and permission mode on the live query', async () => {
  const { session, q } = makeSession()
  await session.apply({ model: 'opus', effort: 'high', permissionMode: 'plan' })
  assert.deepEqual(q.calls.setModel, ['opus'])
  assert.deepEqual(q.calls.flags, [{ effortLevel: 'high' }])
  assert.deepEqual(q.calls.modes, ['plan'])
})

// ---- runtime -------------------------------------------------------------------

function runtimeWith(config, { preset, sandbox = 'workspace-write', approval = 'ask', plan = false, confining = true, visible = () => true } = {}) {
  const services = {
    sessionProjections: { stateOf: (_s, key) => key === 'plan' ? { active: plan } : undefined },
    permissionPresets: { current: () => preset },
    sandboxPolicy: { resolve: () => ({ mode: sandbox }) },
    approval: { overrideOf: () => approval, config: {} },
    shell: confining ? { sandboxMode: 'workspace-write' } : {},
  }
  const ctx = { logger: { info() {}, warn() {} }, agents: { get: () => undefined }, get: () => undefined }
  const agent = { id: 'a', session: {}, ctx: { get: name => services[name], tools: { get: name => visible(name) ? {} : undefined } } }
  return { runtime: new ClaudeCodeRuntime(ctx, resolveConfig({ stateDir: mkdtempSync(join(tmpdir(), 'cc-')), ...config }, '/tmp')), agent }
}

test('permission mode follows dsh plan mode, the Auto preset and the sandbox mode', () => {
  const mode = (opts, config = {}) => {
    const { runtime, agent } = runtimeWith(config, opts)
    return runtime.permissionModeFor(agent)
  }
  assert.equal(mode({ sandbox: 'workspace-write' }), 'acceptEdits')
  // A delegated child: same sandbox as its parent, approval "never" — still edits.
  assert.equal(mode({ sandbox: 'workspace-write', approval: 'never', preset: 'custom' }), 'acceptEdits')
  assert.equal(mode({ sandbox: 'read-only' }), 'default')
  assert.equal(mode({ sandbox: 'danger-full-access' }), 'auto')
  assert.equal(mode({ sandbox: 'danger-full-access', approval: 'never' }, { allowBypass: true }), 'bypassPermissions')
  assert.equal(mode({ sandbox: 'danger-full-access', preset: 'auto' }), 'auto')
  assert.equal(mode({ sandbox: 'danger-full-access', plan: true }, { allowBypass: true }), 'plan')
})

test('sandboxed dsh modes run Claude shell commands through dsh bash', () => {
  const ww = runtimeWith({}, { sandbox: 'workspace-write' })
  assert.equal(ww.runtime.usesDshShell(ww.agent), true)
  assert.ok(ww.runtime.disallowedToolsFor(ww.agent).includes('Bash'))
  const full = runtimeWith({}, { sandbox: 'danger-full-access' })
  assert.equal(full.runtime.usesDshShell(full.agent), false)
  assert.ok(!full.runtime.disallowedToolsFor(full.agent).includes('Bash'))
  const unconfined = runtimeWith({}, { sandbox: 'workspace-write', confining: false })
  assert.equal(unconfined.runtime.usesDshShell(unconfined.agent), false)
})

test('dsh tool visibility (toolFilter) decides which Claude tools exist', () => {
  const { runtime, agent } = runtimeWith({}, { sandbox: 'danger-full-access', visible: name => !['edit', 'write', 'bash', 'pwsh'].includes(name) })
  assert.deepEqual(runtime.disallowedToolsFor(agent), ['Bash', 'Edit', 'Monitor', 'NotebookEdit', 'PowerShell', 'Write'])
})

test('MCP calls are tied to the Claude tool_use they belong to', async () => {
  const state = new AgentState('a')
  const pending = state.claimToolUse('mcp__dsh__present', { files: [{ path: 'b' }] }, 1000)
  state.addPendingToolUse('t1', 'mcp__dsh__present', { files: [{ path: 'a' }] })
  state.addPendingToolUse('t2', 'mcp__dsh__present', { files: [{ path: 'b' }] })
  assert.equal(await pending, 't2')
  assert.equal(await state.claimToolUse('mcp__dsh__present', {}, 10), 't1')
  assert.equal(await state.claimToolUse('mcp__dsh__present', {}, 10), undefined)
})

test('the latest Claude replay record says where to resume or fork', () => {
  const history = [
    { role: 'assistant', source: { provider: 'claude-code', replayState: { response: { claudeSessionId: 'c1', dshSessionId: 'd1', uuid: 'u1' } } }, content: [] },
    { role: 'assistant', source: { provider: 'other' }, content: [] },
  ]
  assert.deepEqual(latestReplay(history, 'claude-code'), { claudeSessionId: 'c1', dshSessionId: 'd1', uuid: 'u1' })
  assert.equal(latestReplay(history, 'nope'), undefined)
})

test('persona sections render with variables for Claude Code', () => {
  const text = renderPersona({ sections: [{ name: 'deployment:persona-prefix', text: 'You run {{model}}.' }, { name: 'tool:bash', text: 'ignored' }, { name: 'deployment:persona-suffix', text: 'Dir {{cwd}}.' }], variables: { model: 'opus', cwd: '/w' }, tools: [] })
  assert.equal(text, 'You run opus.\n\nDir /w.')
})

test('subscription mode strips API credentials by name; api-key mode passes them through', () => {
  process.env.ANTHROPIC_API_KEY = 'x'
  assert.equal(childEnv(resolveConfig({}, '/tmp')).ANTHROPIC_API_KEY, undefined)
  assert.equal(childEnv(resolveConfig({ auth: 'api-key' }, '/tmp')).ANTHROPIC_API_KEY, 'x')
  delete process.env.ANTHROPIC_API_KEY
})

test('handoff transcripts skip dsh-only notices; user images reach Claude as images', async () => {
  const transcript = handoffTranscript([
    { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: '[model changed]' }], source: { kind: 'model-selection' } },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 't', name: 'bash', arguments: '{}' }], source: { kind: 'model' } },
  ])
  assert.equal(transcript, 'User: hello\n\nAssistant: hi\n\nAssistant called tool bash({})')
  const dir = mkdtempSync(join(tmpdir(), 'img-'))
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'p.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  const content = await toClaudeContent([{ type: 'text', text: 'look' }, { type: 'image', attachment: { mediaType: 'image/png' } }], { imageHostPath: () => join(dir, 'p.png'), fileHostPath: () => undefined })
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].source.data, 'iVBORw0KGgo=')
})

test("Claude's TaskCreate/TaskUpdate become dsh todo_write calls with the whole list", () => {
  const state = new AgentState('a')
  const created = taskAwareCall(state, 'TaskCreate', { subject: 'Fix add()', description: 'd' })
  assert.deepEqual(created, { name: 'todo_write', args: { todos: [{ content: 'Fix add()', status: 'pending' }] }, streamsVerbatim: false })
  assert.deepEqual(taskAwareCall(state, 'TaskCreate', { subject: 'Test' }).args.todos, [{ content: 'Fix add()', status: 'pending' }, { content: 'Test', status: 'pending' }])
  state.pendingTaskSubjects.length = 0
  state.claudeTasks.set('1', { content: 'Fix add()', status: 'pending' })
  state.claudeTasks.set('2', { content: 'Test', status: 'pending' })
  assert.deepEqual(taskAwareCall(state, 'TaskUpdate', { taskId: '1', status: 'in_progress' }).args.todos, [{ content: 'Fix add()', status: 'in_progress' }, { content: 'Test', status: 'pending' }])
  assert.deepEqual(taskAwareCall(state, 'TaskUpdate', { taskId: '2', status: 'deleted' }).args.todos, [{ content: 'Fix add()', status: 'pending' }])
  assert.equal(taskAwareCall(state, 'Bash', { command: 'ls' }).name, 'bash')
})
