/**
 * Claude Code's own slash commands as dsh commands in Claude-driven sessions.
 *
 * Commands Claude Code offers (custom commands, skills, plugin commands) are
 * registered as agent-scoped dsh commands for that session only, unless dsh
 * already has a command of the same name (dsh's /compact, /plan, /goal, … keep
 * their dsh behaviour, which this plugin maps onto Claude Code). Running one
 * sends `/<name> <args>` to Claude Code, which executes it natively.
 *
 * @module dsh-claude-code-provider/commands
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from './dsh-types.ts'
import type { AgentState, ClaudeCodeRuntime } from './runtime.ts'
import type { ClaudeSession } from './session.ts'

const COMMAND_NAME = /^[a-z0-9_-]+$/

interface CommandsService {
  find(agent: Agent, name: string): unknown
  register(definition: unknown): () => void
}

export function registerClaudeCommands(runtime: ClaudeCodeRuntime, state: AgentState, agent: Agent, session: ClaudeSession): void {
  if (state.commandsDispose !== undefined) return
  const commands = agent.ctx.get('commands') as CommandsService | undefined
  if (commands === undefined) return
  // Mark as pending so a second session start does not register twice.
  let disposers: Array<() => void> = []
  let released = false
  state.commandsDispose = () => {
    released = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Scope already gone.
      }
    }
    disposers = []
    state.commandsDispose = undefined
  }
  session.supportedCommands().then((list) => {
    if (released) return
    for (const command of list) {
      const name = command.name.replace(/^\//, '')
      if (!COMMAND_NAME.test(name)) continue
      if (commands.find(agent, name) !== undefined) continue
      try {
        disposers.push(commands.register({
          name,
          description: `${command.description} (Claude Code)`,
          ...command.argumentHint === undefined || command.argumentHint === '' ? {} : { input: { hint: command.argumentHint } },
          handler: ({ agent: target, rawInput }: { agent: Agent; rawInput: string }) => {
            target.followup(createUserMessage({
              content: [{ type: 'text', text: `/${name}${rawInput}` }],
              source: { kind: 'user' },
            }))
            return { kind: 'success' as const }
          },
        }))
      } catch (error: unknown) {
        runtime.warn(`could not offer Claude Code command /${name}: ${String(error)}`)
      }
    }
  }).catch((error: unknown) => {
    runtime.warn(`could not list Claude Code commands: ${String(error)}`)
  })
}
