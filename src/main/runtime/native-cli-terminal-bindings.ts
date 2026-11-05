import type { OrcaRuntimeService } from './orca-runtime'

export type NativeCliTerminalBinding = {
  launchId: string
  paneKey: string
  worktreeId: string
  rotating: boolean
  waiters: Set<() => void>
  env: Record<string, string>
  inputTail: Promise<void>
  pendingInputChars: number
  rotationFailed?: boolean
  previousIncarnation?: string | null
  cols: number
  rows: number
  attached?: boolean
  incarnationId: string
  inputReady: boolean
  ended?: boolean
}

export function nativeCliTerminalEnvironment(
  runtime: OrcaRuntimeService,
  paneKey: string
): Record<string, string> {
  return (
    [...(hosts.get(runtime)?.values() ?? [])].find((entry) => entry.paneKey === paneKey)?.env ?? {}
  )
}
const hosts = new WeakMap<object, Map<string, NativeCliTerminalBinding>>()

export function nativeCliTerminalBindings(runtime: object) {
  let bindings = hosts.get(runtime)
  if (!bindings) {
    bindings = new Map()
    hosts.set(runtime, bindings)
  }
  return bindings
}

export function noteNativeCliTerminalRotation(
  runtime: OrcaRuntimeService,
  paneKey: string,
  rotating: boolean
): void {
  const binding = [...(hosts.get(runtime)?.values() ?? [])].find(
    (entry) => entry.paneKey === paneKey
  )
  if (!binding) {
    return
  }
  if (rotating) {
    binding.inputReady = false
    binding.previousIncarnation = runtime.resolveTerminalPane(
      paneKey,
      binding.worktreeId
    ).incarnationId
    binding.rotationFailed = false
  } else {
    try {
      const current = runtime.resolveTerminalPane(paneKey, binding.worktreeId)
      binding.rotationFailed =
        !current.connected ||
        !current.incarnationId ||
        current.incarnationId === binding.previousIncarnation
      if (!binding.rotationFailed && current.incarnationId) {
        binding.incarnationId = current.incarnationId
      }
    } catch {
      binding.rotationFailed = true
    }
  }
  binding.rotating = rotating
  if (!rotating) {
    for (const notify of binding.waiters) {
      notify()
    }
  }
}

export function noteNativeCliTerminalReady(binding: NativeCliTerminalBinding): void {
  binding.inputReady = true
  for (const notify of binding.waiters) {
    notify()
  }
}

export async function waitForNativeCliTerminalInput(
  binding: NativeCliTerminalBinding,
  signal?: AbortSignal
): Promise<void> {
  if (binding.ended) {
    throw new Error('Native CLI input owner has exited')
  }
  while (binding.rotating || !binding.inputReady) {
    if (binding.rotationFailed || binding.ended) {
      throw new Error('Native CLI input owner is unavailable; input was not replayed')
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        binding.waiters.delete(done)
        signal?.removeEventListener('abort', abort)
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(new Error('Native CLI input detached before delivery'))
      }
      if (signal?.aborted) {
        abort()
        return
      }
      binding.waiters.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

export async function waitForNativeCliTerminalRotation(
  binding: NativeCliTerminalBinding,
  signal?: AbortSignal
): Promise<void> {
  if (!binding.rotating) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      binding.waiters.delete(done)
      signal?.removeEventListener('abort', abort)
    }
    const done = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(new Error('Native CLI attachment detached'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    binding.waiters.add(done)
    signal?.addEventListener('abort', abort, { once: true })
  })
  if (binding.rotationFailed) {
    throw new Error('The native CLI replacement is unverifiable; input was not replayed')
  }
}

export function nativeCliTerminalCommand(
  runtime: OrcaRuntimeService,
  paneKey: string,
  command: string
): string {
  return [...(hosts.get(runtime)?.values() ?? [])].some((entry) => entry.paneKey === paneKey)
    ? `exec ${command}`
    : command
}
