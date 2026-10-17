/**
 * dsh session id → Claude session id, persisted so a dsh restart resumes the
 * same Claude conversation. Only ids and paths are stored, never credentials.
 * @module dsh-claude-code-provider/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StoredSession {
  readonly claudeSessionId: string
  readonly cwd: string
  readonly updatedAt: string
}

export class SessionStore {
  private entries: Record<string, StoredSession> = {}

  constructor(private readonly file: string, private readonly log: (message: string) => void) {
    try {
      this.entries = JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredSession>
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`could not read ${file}: ${String(error)}`)
      }
    }
  }

  get(dshSessionId: string): StoredSession | undefined {
    return this.entries[dshSessionId]
  }

  set(dshSessionId: string, claudeSessionId: string, cwd: string): void {
    this.entries[dshSessionId] = { claudeSessionId, cwd, updatedAt: new Date().toISOString() }
    this.save()
  }

  delete(dshSessionId: string): void {
    if (!(dshSessionId in this.entries)) return
    delete this.entries[dshSessionId]
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.entries, null, 2)}\n`)
      renameSync(tmp, this.file)
    } catch (error: unknown) {
      this.log(`could not write ${this.file}: ${String(error)}`)
    }
  }
}
