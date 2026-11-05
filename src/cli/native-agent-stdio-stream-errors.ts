import type { EventEmitter } from 'node:events'

type ErrorStream = Pick<EventEmitter, 'on' | 'removeListener'>

/** Node emits a Writable error separately from its failed write callback. */
export function watchNativeAgentStdioErrors(
  streams: readonly ErrorStream[],
  failed: () => void
): (pending?: Promise<unknown>) => void {
  let active = true
  let reported = false
  const onError = () => {
    if (active && !reported) {
      reported = true
      failed()
    }
  }
  const unique = [...new Set(streams)]
  unique.forEach((stream) => stream.on('error', onError))
  return (pending) => {
    active = false
    // Keep the sink through errors queued after a write callback rejected its consumer.
    const remove = () => {
      setImmediate(() => unique.forEach((stream) => stream.removeListener('error', onError)))
    }
    if (pending) {
      void pending.then(remove, remove)
    } else {
      remove()
    }
  }
}
