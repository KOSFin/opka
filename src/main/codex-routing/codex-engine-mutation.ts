/** Cancellation need not wait for an unrelated native sign-in ahead in the account queue. */
export class CodexEngineMutations {
  private pending = false
  constructor(private readonly lease: <T>(operation: () => Promise<T>) => Promise<T>) {}
  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.pending) {
      return Promise.reject(new Error('A previous routing account mutation is still closing.'))
    }
    this.pending = true
    return new Promise<T>((resolve, reject) => {
      let entered = false
      const abort = () => {
        if (!entered) {
          reject(new Error('Routing account mutation wait was cancelled.'))
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve()
        .then(() =>
          this.lease(async () => {
            signal.throwIfAborted()
            entered = true
            signal.removeEventListener('abort', abort)
            return operation()
          })
        )
        .then(resolve, reject)
        .finally(() => {
          this.pending = false
          signal.removeEventListener('abort', abort)
        })
      if (signal.aborted) {
        abort()
      }
    })
  }
}
