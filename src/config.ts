/**
 * Plugin configuration (the `claude-code` row in `cordis.patch.yml`).
 * @module dsh-claude-code-provider/config
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** How Claude Code permission prompts are decided for the main session. */
export type PermissionSetting = 'follow-dsh' | Exclude<PermissionMode, 'bypassPermissions'>

/** One Claude role used as a dsh subagent (`<model>:<role>` model ids). */
export interface RoleConfig {
  /** Appended to Claude Code's own system prompt. */
  readonly instructions: string
  /** Permission mode for the role; read-only roles use `plan`. */
  readonly permissionMode?: PermissionSetting
  /** Extra Claude Code tools the role may not use. */
  readonly disallowedTools?: readonly string[]
}

/** Local model that does build work for Claude (`delegate_local`). */
export interface LocalModelConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  /** dsh subagent provider that runs it (default `spawn`). */
  readonly subagentProvider?: string
  /** Persona for the local worker; omitted keeps the deployment persona. */
  readonly persona?: string
}

export interface Config {
  /** dsh provider route name shown in the model picker (default `claude-code`). */
  readonly provider?: string
  /** Display name in the model picker (default `Claude Code`). */
  readonly displayName?: string
  /** Installed `claude` binary (default: `~/.local/bin/claude`, else `claude` on PATH). */
  readonly claudePath?: string
  /**
   * `subscription` (default): the binary uses its own `claude auth login`;
   * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from its environment
   * so nothing silently bills an API account. `api-key`: the binary receives the
   * process environment unchanged and authenticates with ANTHROPIC_API_KEY.
   * The plugin never reads either value.
   */
  readonly auth?: 'subscription' | 'api-key'
  /** Main-session permission mode, or `follow-dsh` to follow the session's dsh permission preset. */
  readonly permissionMode?: PermissionSetting
  /**
   * Under `follow-dsh`, map dsh's `danger-full-access` preset to Claude's
   * `bypassPermissions`. Off by default: full access then maps to `acceptEdits`.
   */
  readonly allowBypass?: boolean
  /** Directory for the dsh→Claude session map (default `$DSH_HOME/storages/claude-code`). */
  readonly stateDir?: string
  /** Roles exposed as `<model>:<role>` model ids for dsh subagent rows. */
  readonly roles?: Record<string, RoleConfig>
  /** Local model for `delegate_local`; omitted disables the tool. */
  readonly local?: LocalModelConfig
  /** Claude Code tools never offered in any session. */
  readonly disallowedTools?: readonly string[]
  /** Extra environment entries for the binary. */
  readonly env?: Record<string, string>
  /** List every model the binary reports, not just the aliases (opus, sonnet, …). */
  readonly allModels?: boolean
}

export const DEFAULT_ROLES: Record<string, RoleConfig> = {
  plan: {
    instructions: [
      'You are working as a planning subagent for another coding agent (a local model) that will do the implementation.',
      'Investigate the repository read-only, then answer with a complete, decision-ready implementation plan:',
      'goal and success criteria, the files and functions to change, the order of steps, edge cases, and how to verify the result.',
      'Do not edit files. Your final message is the plan itself.',
    ].join(' '),
    permissionMode: 'plan',
    disallowedTools: ['ExitPlanMode'],
  },
  review: {
    instructions: [
      'You are working as a code-review subagent for another coding agent.',
      'Review the change or files you are pointed at, read-only. Report concrete correctness bugs first',
      '(file:line, what breaks, how to trigger it), then risky gaps in tests or error handling, then optional cleanups.',
      'Do not edit files. If you find nothing wrong, say so plainly.',
    ].join(' '),
    permissionMode: 'plan',
    disallowedTools: ['ExitPlanMode'],
  },
}

export interface ResolvedConfig {
  readonly provider: string
  readonly displayName: string
  readonly claudePath: string
  readonly auth: 'subscription' | 'api-key'
  readonly permissionMode: PermissionSetting
  readonly allowBypass: boolean
  readonly stateDir: string
  readonly roles: Record<string, RoleConfig>
  readonly local: LocalModelConfig | undefined
  readonly disallowedTools: readonly string[]
  readonly env: Record<string, string>
  readonly allModels: boolean
}

/** Locate the installed binary without running it. */
export function findClaudeBinary(): string {
  const local = join(homedir(), '.local', 'bin', 'claude')
  if (existsSync(local)) return local
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, 'claude')
    if (existsSync(candidate)) return candidate
  }
  return local
}

export function resolveConfig(config: Config | undefined, dshHome: string): ResolvedConfig {
  const c = config ?? {}
  return {
    provider: c.provider ?? 'claude-code',
    displayName: c.displayName ?? 'Claude Code',
    claudePath: c.claudePath ?? findClaudeBinary(),
    auth: c.auth ?? 'subscription',
    permissionMode: c.permissionMode ?? 'follow-dsh',
    allowBypass: c.allowBypass ?? false,
    stateDir: c.stateDir ?? join(dshHome, 'storages', 'claude-code'),
    roles: { ...DEFAULT_ROLES, ...c.roles },
    local: c.local,
    disallowedTools: c.disallowedTools ?? [],
    env: c.env ?? {},
    allModels: c.allModels ?? false,
  }
}

/** Environment for the binary. Names are removed, values are never inspected. */
export function childEnv(config: ResolvedConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...config.env }
  if (config.auth === 'subscription') {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }
  // Identify the integration to Claude Code like other SDK hosts do.
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'dsh-claude-code-provider/0.0.1'
  return env
}
