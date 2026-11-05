import type { NativeClaudeHookRequest } from '../../shared/native-claude-hook'

/** Pending admissions only wait on owner/canonical changes, never a polling loop. */
export function createNativeClaudeHookAdmission(
  check: (request: NativeClaudeHookRequest) => boolean,
  isClosed: () => boolean
) {
  const waiting = new Set<() => void>()
  return {
    recheck: () => {
      for (const wake of waiting) {
        wake()
      }
    },
    accept: async (request: NativeClaudeHookRequest, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      if (!check(request)) {
        if (waiting.size >= 128) {
          throw new Error('Claude native hook admission is busy.')
        }
        const stopped = AbortSignal.any([
          AbortSignal.timeout(request.event === 'failure' ? 45000 : 5000),
          ...(signal ? [signal] : [])
        ])
        await new Promise<void>((resolve, reject) => {
          const finish = (accepted: boolean) => {
            waiting.delete(wake)
            stopped.removeEventListener('abort', abort)
            if (accepted) {
              resolve()
            } else {
              reject(new Error('Claude native hook ownership is unverifiable.'))
            }
          }
          const wake = () => {
            if (check(request)) {
              finish(true)
            } else if (isClosed() || stopped.aborted) {
              finish(false)
            }
          }
          const abort = () => finish(false)
          waiting.add(wake)
          stopped.addEventListener('abort', abort, { once: true })
          wake()
        })
      }
      signal?.throwIfAborted()
    }
  }
}
