import type { NativeCliStartup } from './native-cli-startup'

export function createNativeCliStartupReadiness(
  startup: NativeCliStartup | null,
  signal?: AbortSignal
) {
  if (startup?.refusal) {
    throw startup.refusal
  }
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  if (signal?.aborted) {
    stop.abort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const unsubscribe = startup?.onRefusal(onAbort)
  return {
    stop,
    ready: () => startup?.finish('prepared'),
    async wait(operation: Promise<string | null>): Promise<string> {
      try {
        const ptyId = await operation
        if (startup?.refusal) {
          throw startup.refusal
        }
        if (!ptyId) {
          throw new Error(
            signal?.aborted
              ? 'request_aborted'
              : stop.signal.aborted
                ? 'agent_startup_dialog'
                : 'timeout'
          )
        }
        return ptyId
      } catch (error) {
        throw startup?.refusal ?? error
      } finally {
        signal?.removeEventListener('abort', onAbort)
        unsubscribe?.()
      }
    }
  }
}
