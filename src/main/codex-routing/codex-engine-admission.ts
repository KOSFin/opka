export class CodexEngineAdmission {
  private queue: Promise<unknown> = Promise.resolve()
  private blocked = 0
  private readonly controllers = new Set<AbortController>()
  closing = false
  constructor(private readonly timeoutMs: number) {}
  get accepting(): boolean {
    return !this.closing && this.blocked === 0
  }
  beginShutdown(): void {
    this.closing = true
    this.controllers.forEach((controller) => controller.abort())
  }
  run<T>(
    parent: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    allowClosing = false,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    if (this.closing && !allowClosing) {
      return Promise.reject(new Error('The routing host is shutting down.'))
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    parent?.addEventListener('abort', abort, { once: true })
    if (parent?.aborted) {
      abort()
    }
    const timer = setTimeout(abort, timeoutMs)
    this.controllers.add(controller)
    this.blocked++
    const run = async () => {
      controller.signal.throwIfAborted()
      return operation(controller.signal)
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next.finally(() => {
      this.blocked--
      this.controllers.delete(controller)
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    })
  }
}
