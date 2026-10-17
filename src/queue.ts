/**
 * Small async primitives shared by the Claude session and the local-model queue.
 * @module dsh-claude-code-provider/queue
 */

/** Unbounded push queue consumed as an async iterable (the SDK's streaming input). */
export class PushQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | undefined
  private ended = false

  push(item: T): void {
    if (this.ended) throw new Error('push after end')
    this.items.push(item)
    this.waiter?.()
  }

  end(): void {
    this.ended = true
    this.waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => { this.waiter = resolve })
      this.waiter = undefined
    }
  }
}

/** One settled-later value. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  // Waiters may be abandoned (cancelled tool calls); never surface as unhandled.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Race a promise against an abort signal.
 * @param promise - the work to wait for.
 * @param signal - aborting rejects with the signal's reason.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason ?? new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** Runs async jobs one at a time, in arrival order (one local GPU model). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private waiting = 0

  get pending(): number {
    return this.waiting
  }

  run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.waiting += 1
    const start = this.tail.then(() => {
      this.waiting -= 1
      signal?.throwIfAborted()
      return job()
    }, () => {
      this.waiting -= 1
      signal?.throwIfAborted()
      return job()
    })
    this.tail = start.catch(() => {})
    return start
  }
}
