// Starts the installed claude binary through the Agent SDK, lists models, exits. Sends no prompt.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
async function* never() { await new Promise(() => {}) }
const q = query({ prompt: never(), options: { pathToClaudeCodeExecutable: `${homedir()}/.local/bin/claude`, permissionMode: 'default', persistSession: false } })
try {
  const models = await q.supportedModels()
  console.log(JSON.stringify(models.map(m => ({ value: m.value, resolved: m.resolvedModel, name: m.displayName, effort: m.supportedEffortLevels, adaptive: m.supportsAdaptiveThinking })), null, 1))
} finally { q.close() }
