type Boundary = { canSwitch: () => boolean; onBoundaryAccepted: () => void }

/** Concurrent saved-policy acknowledgements share the one owning session's serialized publication. */
export function createNativeClaudeIdlePublication(options: {
  canApply: () => boolean
  readBoundary?: () => Boundary
  apply: (boundary: Boundary, signal?: AbortSignal) => Promise<boolean>
  enqueue: (run: () => Promise<boolean>) => Promise<boolean>
}) {
  let pending: Promise<boolean> | undefined
  return (signal?: AbortSignal): Promise<boolean> => {
    const boundary = options.readBoundary
    if (!options.canApply() || !boundary) {
      return Promise.resolve(false)
    }
    if (pending) {
      return pending
    }
    const operation = options.enqueue(() => options.apply(boundary(), signal))
    pending = operation.finally(() => {
      pending = undefined
    })
    return pending
  }
}
