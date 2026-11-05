import { StringDecoder } from 'node:string_decoder'

/** One local result starts one serialized source-read loop; native close joins its final read. */
export function createClaudeNativeRefreshMonitor(options: {
  signal?: AbortSignal
  readFresh: () => Promise<boolean>
  timeoutMs: number
}) {
  const controller = new AbortController()
  const decoder = new StringDecoder('utf8')
  let bytes = 0,
    buffer = '',
    successfulResult = false,
    readyStop = false
  let closed = false,
    failed = false,
    expired = false
  let pending: Promise<void> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let wakeRetry: (() => void) | undefined
  const wake = () => {
    clearTimeout(retryTimer)
    wakeRetry?.()
    wakeRetry = undefined
  }
  const abort = () => {
    controller.abort()
    wake()
  }
  const deadline = setTimeout(() => {
    expired = true
    abort()
  }, options.timeoutMs)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) {
    abort()
  }
  const stopped = () => closed || controller.signal.aborted
  const readUntilFresh = async () => {
    try {
      for (let attempt = 0; attempt < 64 && !stopped(); attempt++) {
        if (await options.readFresh()) {
          if (!stopped()) {
            readyStop = true
            clearTimeout(deadline)
            controller.abort()
          }
          return
        }
        if (stopped()) {
          return
        }
        await new Promise<void>((resolve) => {
          wakeRetry = resolve
          retryTimer = setTimeout(
            () => {
              wakeRetry = undefined
              resolve()
            },
            Math.min(50 * 2 ** attempt, 2000)
          )
        })
      }
      if (!stopped()) {
        failed = true
        abort()
      }
    } catch {
      failed = true
      abort()
    }
  }
  const line = (text: string) => {
    if (successfulResult || stopped()) {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (
      frame &&
      typeof frame === 'object' &&
      'type' in frame &&
      frame.type === 'result' &&
      'subtype' in frame &&
      frame.subtype === 'success' &&
      'is_error' in frame &&
      frame.is_error === false
    ) {
      successfulResult = true
      pending = readUntilFresh()
    }
  }
  return {
    signal: controller.signal,
    fail() {
      failed = true
      abort()
    },
    onStdout(chunk: Buffer | string) {
      if (closed) {
        return
      }
      bytes += Buffer.byteLength(chunk)
      if (bytes > 64 * 1024) {
        failed = true
        abort()
        return
      }
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
      }
    },
    onClosed() {
      closed = true
      clearTimeout(deadline)
      wake()
    },
    async finish() {
      closed = true
      clearTimeout(deadline)
      wake()
      options.signal?.removeEventListener('abort', abort)
      await pending
      buffer = ''
    },
    get successfulResult() {
      return successfulResult && !failed && !expired && !options.signal?.aborted
    },
    get readyStopped() {
      return readyStop && !failed && !expired && !options.signal?.aborted
    }
  }
}
