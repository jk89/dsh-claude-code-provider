// Test-only dsh plugin: a scripted "local model" provider (no real model). It answers
// delegate_local tasks, and acts as a dsh-native parent that calls claude_plan.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const name = 'fake-local'
export const inject = ['llm']
const text = blocks => (blocks ?? []).map(b => b.text ?? '').join(' ')
class Scripted extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'scripted', name: 'scripted local' }] }
  async *stream(options) {
    const lastUser = [...options.messages].reverse().find(m => m.role === 'user' && m.source?.kind !== 'runtime-context')
    const lastTool = options.messages.at(-1)?.role === 'tool' ? options.messages.at(-1) : undefined
    const call = /CALL (claude_\w+)(?: PROMPT=(.*))?/.exec(text(lastUser?.content))
    if (lastTool === undefined && call !== null) {
      const tool = call[1]
      const args = JSON.stringify({ description: 'Work via Claude', prompt: call[2] ?? 'SCENARIO echo plan the subtract feature', run_in_background: false })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'call_role_1', name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_role_1', name: tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const reply = lastTool !== undefined ? `PARENT GOT: ${text(lastTool.content).slice(0, 300)}` : `LOCAL DONE: ${text(lastUser?.content).slice(0, 80)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['fake-local'], new Scripted()) }
