export async function waitForCodexEngineSessions(
  changed: Set<() => void>,
  signal: AbortSignal,
  safe: () => boolean
): Promise<void> {
  signal.throwIfAborted()
  if (safe()) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      changed.delete(check)
      signal.removeEventListener('abort', abort)
    }
    const check = () => {
      if (safe()) {
        cleanup()
        resolve()
      }
    }
    const abort = () => {
      cleanup()
      reject(new Error('Native routing boundary wait was cancelled.'))
    }
    changed.add(check)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    } else {
      check()
    }
  })
}
