/**
 * Claude Code background tasks as dsh background jobs.
 *
 * A backgrounded Bash command (or monitor/workflow task) Claude starts is
 * registered in dsh's job registry under the Claude session's owner, so it
 * shows in the jobs panel, `job_output` reads it, and stopping it in dsh stops
 * it in Claude Code (`stopTask`). Claude's progress lines become the job's
 * progress; its completion notice settles the job with the task's output.
 * Background sub-agents are shown as dsh child sessions instead (agents.ts).
 *
 * @module dsh-claude-code-provider/tasks
 */

import { readFile } from 'node:fs/promises'
import type { Agent } from './dsh-types.ts'
import { deferred, type Deferred } from './queue.ts'
import type { AgentState, ClaudeCodeRuntime } from './runtime.ts'

interface JobBinding {
  readonly taskId: string
  jobId: string | undefined
  handle: { append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log' }): void; updateProgress(line: string): void } | undefined
  readonly done: Deferred<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>
}

type TaskMessage = Record<string, any>

const OUTPUT_TAIL_BYTES = 64 * 1024

export class TaskJobs {
  private readonly bindings = new Map<string, JobBinding>()
  private readonly registered = new Map<string, Deferred<string | undefined>>()

  constructor(private readonly runtime: ClaudeCodeRuntime) {}

  private registration(taskId: string): Deferred<string | undefined> {
    let entry = this.registered.get(taskId)
    if (entry === undefined) {
      entry = deferred<string | undefined>()
      this.registered.set(taskId, entry)
    }
    return entry
  }

  /** dsh job id for a Claude task, waiting briefly for it to be registered. */
  async jobIdFor(_state: AgentState, taskId: string, ms: number): Promise<string | undefined> {
    const entry = this.registration(taskId)
    return Promise.race([entry.promise, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms).unref())])
  }

  onTask(state: AgentState, agent: Agent, message: unknown): void {
    const task = message as TaskMessage
    const taskId = typeof task.task_id === 'string' ? task.task_id : undefined
    if (taskId === undefined) return
    switch (task.subtype) {
      case 'task_started':
        if (this.isAgentTask(task)) {
          this.registration(taskId).resolve(undefined)
          return
        }
        this.start(state, agent, taskId, String(task.description ?? 'Claude Code background task'))
        return
      case 'task_progress': {
        const binding = this.bindings.get(taskId)
        binding?.handle?.updateProgress(String(task.summary ?? task.description ?? ''))
        return
      }
      case 'task_updated': {
        const status = task.patch?.status
        if (status === 'killed' || status === 'failed' || status === 'completed') {
          // The notification normally follows with the output; settle if it never does.
          const binding = this.bindings.get(taskId)
          if (binding !== undefined) {
            setTimeout(() => {
              binding.done.resolve({ status: status === 'killed' ? 'killed' : status, ...task.patch?.error === undefined ? {} : { detail: String(task.patch.error) } })
            }, 5_000).unref()
          }
        }
        return
      }
      case 'task_notification':
        void this.finish(taskId, task)
        return
      default:
        return
    }
  }

  private isAgentTask(task: TaskMessage): boolean {
    return typeof task.subagent_type === 'string' || (typeof task.task_type === 'string' && task.task_type.includes('agent'))
  }

  private start(state: AgentState, agent: Agent, taskId: string, label: string): void {
    const jobs = (agent.ctx.get('jobs') ?? this.runtime.ctx.get('jobs')) as {
      start(spec: unknown): string
    } | undefined
    const registration = this.registration(taskId)
    if (jobs === undefined) {
      registration.resolve(undefined)
      return
    }
    const binding: JobBinding = { taskId, jobId: undefined, handle: undefined, done: deferred() }
    this.bindings.set(taskId, binding)
    try {
      const jobId = jobs.start({
        kind: 'claude',
        label,
        owner: agent.id,
        run: (handle: JobBinding['handle']) => {
          binding.handle = handle
          return {
            cancel: () => {
              state.claude?.stopTask(taskId).catch((error: unknown) => {
                this.runtime.warn(`could not stop Claude task ${taskId}: ${String(error)}`)
              })
            },
            done: binding.done.promise,
          }
        },
      })
      binding.jobId = jobId
      state.jobIds.add(jobId)
      state.jobForTask.set(taskId, jobId)
      registration.resolve(jobId)
    } catch (error: unknown) {
      this.bindings.delete(taskId)
      registration.resolve(undefined)
      this.runtime.warn(`could not register Claude task ${taskId} as a dsh job: ${String(error)}`)
    }
  }

  private async finish(taskId: string, task: TaskMessage): Promise<void> {
    const binding = this.bindings.get(taskId)
    if (binding === undefined) return
    const outputFile = typeof task.output_file === 'string' ? task.output_file : undefined
    if (outputFile !== undefined && binding.handle !== undefined) {
      try {
        const data = await readFile(outputFile)
        const tail = data.length > OUTPUT_TAIL_BYTES ? data.subarray(data.length - OUTPUT_TAIL_BYTES) : data
        if (tail.length > 0) binding.handle.append(tail.toString('utf8'), { channel: 'stdout' })
      } catch {
        // Output file already gone.
      }
    }
    const status = task.status === 'completed' ? 'completed' : task.status === 'stopped' ? 'killed' : 'failed'
    binding.done.resolve({ status, ...typeof task.summary === 'string' && task.summary.length > 0 ? { detail: task.summary } : {} })
    this.bindings.delete(taskId)
  }
}
